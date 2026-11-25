import { test } from "node:test";
import assert from "node:assert/strict";
import { evalFormula, parseFormula, substituteNames, type FormulaContext } from "./formula.ts";

const ctx: FormulaContext = {
  prof: 6, level: 20, classLevels: { fighter: 20 },
  mods: { str: 1, dex: 5, con: 3, int: 2, wis: 4, cha: -1 },
};

const value = (f: string, c: FormulaContext = ctx) => {
  const p = parseFormula(f);
  assert.ok(p.ok, p.ok ? "" : p.error);
  const v = evalFormula(p.value, c);
  assert.ok(v.ok, v.ok ? "" : v.error);
  return v.value;
};

test("level(class) + mod(ability) reads the creature's numbers", () => {
  assert.equal(value("level(fighter) + mod(con)"), 23);
});

test("level(class) is 0 for a class the creature has no levels in", () => {
  assert.equal(value("level(wizard)"), 0);
});

test("division rounds down", () => {
  assert.equal(value("level / 3"), 6);
  assert.equal(value("7 / 2"), 3);
});

test("multiplication binds tighter than addition, and parentheses group", () => {
  assert.equal(value("prof * 2 + 1"), 13);
  assert.equal(value("prof * (2 + 1)"), 18);
});

test("a negative modifier subtracts", () => {
  assert.equal(value("8 + prof + mod(cha)"), 13);
});

test("an unknown name is refused", () => {
  assert.ok(!parseFormula("strength + 2").ok);
});

test("dice are refused in formulas", () => {
  const r = parseFormula("1d6 + 2");
  assert.ok(!r.ok);
  assert.match(r.error, /dice/);
});

test("level without a recorded level is an error, not zero", () => {
  const p = parseFormula("level");
  assert.ok(p.ok);
  assert.ok(!evalFormula(p.value, { ...ctx, level: undefined }).ok);
});

test("names in a dice expression are replaced, with signs normalised", () => {
  const r = substituteNames("1d8 + mod(cha)", ctx);
  assert.ok(r.ok);
  assert.equal(r.value, "1d8-1");
  const s = substituteNames("2d6 + mod(str) + prof", ctx);
  assert.ok(s.ok);
  assert.equal(s.value, "2d6+1+6");
});
