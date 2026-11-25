import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { applyLoadout, parseLoadout, serialiseLoadout } from "./loadout.ts";
import type { Combatant } from "../engine/types.ts";

const WIKI = join(import.meta.dirname, "../../test/fixtures/homebrew");

const sheet: Combatant = {
  id: "djarrak", name: "D'jarrak", ac: 16,
  hp: { current: 50, max: 50, temp: 0 },
  abilities: { str: 10, dex: 18, con: 14, int: 10, wis: 10, cha: 10 },
  proficiencyBonus: 6, saveProficiencies: [], speed: 30,
  resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
  conditions: [], exhaustion: 0, concentration: null,
  deathSaves: { successes: 0, failures: 0 }, stable: false, isPlayer: true,
  attacks: [{ name: "Ice Katars", bonus: 10, damage: [{ expression: "1d6+4", type: "piercing" }] }],
};

test("a loadout file reads items, attunement and as-attack", () => {
  const r = parseLoadout({ items: [{ note: "Fungicide Blade", attuned: true, "as-attack": "flame tongue greatsword" }] }, "x");
  assert.ok(r.ok);
  assert.deepEqual(r.value, [{ note: "Fungicide Blade", attuned: true, asAttack: "flame tongue greatsword" }]);
  assert.deepEqual(JSON.parse(serialiseLoadout(r.value)), { items: [{ note: "Fungicide Blade", attuned: true, "as-attack": "flame tongue greatsword" }] });
});

test("a malformed loadout is refused with the item at fault", () => {
  const r = parseLoadout({ items: [{ attuned: true }] }, "bokun.loadout.json");
  assert.ok(!r.ok);
  assert.match(r.error, /items\[0\]/);
});

test("applying a loadout reads each item's effects block from the wiki", async () => {
  const r = await applyLoadout(sheet, [{ note: "Voidfang Katars", attuned: true }], WIKI);
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.deepEqual(r.value.combatant.attacks!.map((a) => a.name), ["Voidfang Katars"]);
  assert.match(r.value.lines[0]!, /Voidfang Katars \(attuned\)/);
});

test("a loadout naming a note with no effects block is refused", async () => {
  const r = await applyLoadout(sheet, [{ note: "Sporeling", attuned: false }], WIKI);
  assert.ok(!r.ok);
  assert.match(r.error, /no ```effects block/);
});
