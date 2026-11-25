import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml } from "./yaml.ts";

const parse = (text: string) => {
  const r = parseYaml(text);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.value;
};

test("block maps, block sequences and flow collections nest", () => {
  const v = parse([
    "name: Thing",
    "effects:",
    "  - on: incoming-damage",
    "    unless: {tag: unphased}",
    "    do: {scale: 1/4, round: down}",
    "  - feature: Shadowstep",
    "    uses: {max: 1, per: round}",
    "list: [a, b, {c: 1}]",
  ].join("\n"));
  assert.deepEqual(v, {
    name: "Thing",
    effects: [
      { on: "incoming-damage", unless: { tag: "unphased" }, do: { scale: "1/4", round: "down" } },
      { feature: "Shadowstep", uses: { max: 1, per: "round" } },
    ],
    list: ["a", "b", { c: 1 }],
  });
});

test("a leading plus sign reads as a number", () => {
  assert.deepEqual(parse("bonus: +3"), { bonus: 3 });
});

test("a key followed by a sequence at the same indentation is a list", () => {
  assert.deepEqual(parse("do:\n- set-hp: 1\n- temphp: 5"), { do: [{ "set-hp": 1 }, { temphp: 5 }] });
});

test("comments after values are stripped, but a # inside quotes is kept", () => {
  assert.deepEqual(parse('a: 1   # note\nb: "x # y"'), { a: 1, b: "x # y" });
});

test("literal block strings keep their line breaks", () => {
  assert.deepEqual(parse("text: |\n  one\n  two\nnext: 1"), { text: "one\ntwo", next: 1 });
});

test("duplicate keys are refused with the line number", () => {
  const r = parseYaml("a: 1\na: 2");
  assert.ok(!r.ok);
  assert.match(r.error, /line 2: duplicate key "a"/);
});

test("tabs in indentation are refused", () => {
  const r = parseYaml("a:\n\tb: 1");
  assert.ok(!r.ok);
  assert.match(r.error, /tabs/);
});

test("anchors and aliases are refused rather than misread", () => {
  const r = parseYaml("a: &x 1");
  assert.ok(!r.ok);
});
