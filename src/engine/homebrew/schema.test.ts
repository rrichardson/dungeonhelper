import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDef } from "./schema.ts";
import { parseYaml } from "./yaml.ts";

const check = (yaml: string) => {
  const y = parseYaml(yaml);
  assert.ok(y.ok, y.ok ? "" : y.error);
  return validateDef(y.value);
};

const refused = (yaml: string, pattern: RegExp) => {
  const r = check(yaml);
  assert.ok(!r.ok, "expected a refusal");
  assert.match(r.error, pattern);
};

test("a minimal static item validates", () => {
  const r = check("name: Ring of Protection\nkind: item\nattunement: true\neffects:\n  - do: {ac: 1, save-bonus: 1}");
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.value.id, "ring-of-protection");
  assert.deepEqual(r.value.effects[0]!.actions[0], { kind: "grant", grant: { ac: 1, saveBonus: { all: 1 } }, to: "self" });
});

test("an unknown key is refused with its path", () => {
  refused("name: X\nkind: item\neffects:\n  - do: {ac: 1}\n    sometimes: true", /effects\[0\]: unknown key "sometimes"/);
});

test("an action that does not belong on its hook is refused", () => {
  refused("name: X\nkind: item\neffects:\n  - on: incoming-damage\n    do: {add-damage: \"1d6:fire\"}", /cannot be used with on: incoming-damage/);
});

test("an effect with limited uses needs a name", () => {
  refused("name: X\nkind: item\neffects:\n  - on: would-drop-to-0\n    uses: {max: 1, per: long-rest}\n    do: {set-hp: 1}", /needs a name/);
});

test("would-drop-to-0 must say what the creature drops to instead", () => {
  refused("name: X\nkind: item\neffects:\n  - name: Y\n    on: would-drop-to-0\n    do: {temphp: 5}", /needs a set-hp/);
});

test("a triggered grant needs a duration", () => {
  refused("name: X\nkind: item\neffects:\n  - on: critical-hit\n    do: {ac: 2}", /needs an until/);
});

test("a static grant may not have a duration", () => {
  refused("name: X\nkind: item\neffects:\n  - do: {ac: 2, until: end-of-holder-next-turn}", /permanent/);
});

test("an unknown damage type is refused", () => {
  refused("name: X\nkind: weapon\neffects:\n  - on: outgoing-damage\n    do: {add-damage: \"1d6:gravity\"}", /unknown damage type "gravity"/);
});

test("only weapons can replace or grant attacks", () => {
  refused("name: X\nkind: item\nreplaces-attack: dagger", /only kind: weapon/);
});

test("a condition aimed at another creature needs a hook that has one", () => {
  refused("name: X\nkind: item\neffects:\n  - name: Y\n    on: would-drop-to-0\n    do:\n      - set-hp: 1\n      - condition: prone\n        to: target", /no other creature/);
});

test("two effects with the same name are refused", () => {
  refused("name: X\nkind: item\neffects:\n  - feature: A\n    text: a\n  - feature: A\n    text: b", /both named "A"/);
});
