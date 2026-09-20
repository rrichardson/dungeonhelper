import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveEncounter, loadEncounter } from "./store.ts";
import { parseCombatant } from "./sheets.ts";
import {
  createEncounter, addCombatant, setCondition, setConcentration, setExhaustion,
  damageCombatant, rollInitiativeFor, startEncounter,
} from "../engine/encounter.ts";
import type { Combatant } from "../engine/types.ts";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.value;
}

const sheet = {
  id: "aria", name: "Aria", ac: 18, isPlayer: true,
  hp: { max: 31, current: 31 },
  abilities: { str: 16, dex: 14, con: 15, int: 10, wis: 12, cha: 8 },
  proficiencyBonus: 3, saveProficiencies: ["str", "con"], speed: 30,
  attacks: [{ name: "longsword", bonus: 6, damage: [{ expression: "1d8+4", type: "slashing" }] }],
};

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dnd-store-"));
  return join(dir, "current.json");
}

test("a sheet parses from plain JSON", () => {
  const c = unwrap(parseCombatant(sheet, "aria.json"));
  assert.equal(c.ac, 18);
  assert.equal(c.attacks?.[0]?.name, "longsword");
});

test("an encounter survives a save/load round trip", async () => {
  const path = await tempPath();
  const aria = unwrap(parseCombatant(sheet, "aria.json"));

  let state = createEncounter("Round Trip", "seed-rt");
  state = unwrap(addCombatant(state, aria));
  state = unwrap(rollInitiativeFor(state, ["aria"])).state;
  state = unwrap(startEncounter(state));

  unwrap(await saveEncounter(path, state));
  const loaded = unwrap(await loadEncounter(path));

  assert.equal(loaded.name, state.name);
  assert.equal(loaded.seed, state.seed);
  assert.equal(loaded.round, state.round);
  assert.equal(loaded.rollCount, state.rollCount);
  assert.deepEqual(loaded.order, state.order);
  assert.equal(loaded.combatants["aria"]!.hp.current, 31);
});

test("applied conditions survive a round trip", async () => {
  const path = await tempPath();
  const aria = unwrap(parseCombatant(sheet, "aria.json"));

  let state = createEncounter("Conditions", "seed-c");
  state = unwrap(addCombatant(state, aria));
  state = unwrap(setCondition(state, "aria", "grappled", true, "ogre")).state;
  state = unwrap(setCondition(state, "aria", "prone", true)).state;

  unwrap(await saveEncounter(path, state));
  const loaded = unwrap(await loadEncounter(path));

  const conditions = loaded.combatants["aria"]!.conditions;
  assert.equal(conditions.length, 2);
  const grappled = conditions.find((c) => c.condition === "grappled");
  assert.equal(grappled?.source, "ogre", "the grappler's identity must survive reloading");
});

test("concentration, exhaustion and death saves survive a round trip", async () => {
  const path = await tempPath();
  const aria = unwrap(parseCombatant(sheet, "aria.json"));

  let state = createEncounter("Volatile", "seed-v");
  state = unwrap(addCombatant(state, aria));
  state = unwrap(setConcentration(state, "aria", "Bless"));
  state = unwrap(setExhaustion(state, "aria", 3)).state;
  state = unwrap(damageCombatant(state, "aria", [{ amount: 40, type: "force" }])).state;

  const before = state.combatants["aria"]!;
  unwrap(await saveEncounter(path, state));
  const loaded = unwrap(await loadEncounter(path));
  const c = loaded.combatants["aria"]!;

  assert.equal(c.exhaustion, 3);
  assert.equal(c.hp.current, 0);
  assert.ok(c.conditions.some((x) => x.condition === "unconscious"));
  assert.deepEqual(c.concentration, before.concentration, "concentration must reload as it was saved");
  assert.deepEqual(c.deathSaves, before.deathSaves);
  assert.equal(c.stable, before.stable);
});

test("a held concentration reloads intact", async () => {
  const path = await tempPath();
  const aria = unwrap(parseCombatant(sheet, "aria.json"));
  let state = createEncounter("Holding", "seed-h");
  state = unwrap(addCombatant(state, aria));
  state = unwrap(setConcentration(state, "aria", "Spirit Guardians"));

  unwrap(await saveEncounter(path, state));
  const loaded = unwrap(await loadEncounter(path));
  assert.equal(loaded.combatants["aria"]!.concentration?.spell, "Spirit Guardians");
});

test("a hand-written sheet may list conditions as bare names", () => {
  const c = unwrap(parseCombatant({ ...sheet, conditions: ["prone", "poisoned"] }, "x.json"));
  assert.deepEqual(c.conditions.map((a) => a.condition), ["prone", "poisoned"]);
});

test("loading reports the exact field at fault", async () => {
  const path = await tempPath();
  await writeFile(path, JSON.stringify({
    version: 1,
    state: { ...createEncounter("Bad", "s"), combatants: { aria: { ...sheet, ac: "eighteen" } } },
  }), "utf8");
  const loaded = await loadEncounter(path);
  assert.equal(loaded.ok, false);
  assert.match(loaded.ok ? "" : loaded.error, /combatants\.aria: "ac" must be a number/);
});

test("an unknown state version is refused rather than guessed at", async () => {
  const path = await tempPath();
  await writeFile(path, JSON.stringify({ version: 99, state: {} }), "utf8");
  const loaded = await loadEncounter(path);
  assert.equal(loaded.ok, false);
  assert.match(loaded.ok ? "" : loaded.error, /unsupported state version 99/);
});

test("a missing encounter file explains how to make one", async () => {
  const loaded = await loadEncounter(join(tmpdir(), "definitely-missing-dnd.json"));
  assert.equal(loaded.ok, false);
  assert.match(loaded.ok ? "" : loaded.error, /dnd new/);
});

test("invalid stat blocks are rejected with a usable message", () => {
  const cases: [unknown, RegExp][] = [
    [{ ...sheet, abilities: { str: 16 } }, /abilities\.dex/],
    [{ ...sheet, hp: { max: 0 } }, /hp\.max must be at least 1/],
    [{ ...sheet, resistances: ["sonic"] }, /"resistances" contains "sonic"/],
    [{ ...sheet, id: "has spaces" }, /"id" must be alphanumeric/],
    [{ ...sheet, attacks: [{ name: "x", bonus: 1, damage: [{ expression: "1d6", type: "sonic" }] }] }, /"type" must be one of/],
  ];
  for (const [input, pattern] of cases) {
    const r = parseCombatant(input, "t.json");
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(input).slice(0, 60)}`);
    assert.match(r.ok ? "" : r.error, pattern);
  }
});
