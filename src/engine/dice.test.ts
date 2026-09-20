import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDice, roll, rollParsed, diceCount, range } from "./dice.ts";
import { makeRng, makeFixedRng, FixedRngExhausted } from "./rng.ts";

import type { Rng } from "./rng.ts";

const fixed = (...v: number[]): Rng => makeFixedRng(v);
const mustRoll = (expr: string, rng: Rng) => {
  const r = roll(expr, rng);
  assert.ok(r.ok, `expected "${expr}" to parse: ${r.ok ? "" : r.error}`);
  return r.value;
};

test("parses and sums a flat expression", () => {
  const r = mustRoll("2d6+3", fixed(4, 5));
  assert.equal(r.total, 12);
  assert.equal(r.terms.length, 2);
  assert.deepEqual(r.terms[0]!.rolls.map((d) => d.value), [4, 5]);
});

test("subtraction applies to the whole term", () => {
  const r = mustRoll("1d20-1d4", fixed(20, 3));
  assert.equal(r.total, 17);
});

test("4d6kh3 drops the lowest die but still reports it", () => {
  const r = mustRoll("4d6kh3", fixed(1, 6, 3, 5));
  assert.equal(r.total, 14);
  const rolls = r.terms[0]!.rolls;
  assert.deepEqual(rolls.map((d) => d.value), [1, 6, 3, 5]);
  assert.deepEqual(rolls.map((d) => d.kept), [false, true, true, true]);
});

test("kl keeps the lowest — the disadvantage shape", () => {
  const r = mustRoll("2d20kl1", fixed(18, 4));
  assert.equal(r.total, 4);
});

test("drop-lowest and keep-highest agree on equivalent requests", () => {
  const a = mustRoll("4d6kh3", fixed(2, 3, 4, 5));
  const b = mustRoll("4d6dl1", fixed(2, 3, 4, 5));
  assert.equal(a.total, b.total);
});

test("ties in keep/drop do not lose or duplicate dice", () => {
  const r = mustRoll("4d6kh3", fixed(3, 3, 3, 3));
  assert.equal(r.total, 9);
  assert.equal(r.terms[0]!.rolls.filter((d) => d.kept).length, 3);
});

test("every die result stays inside the die's range", () => {
  const rng = makeRng("range-check");
  for (let i = 0; i < 2000; i++) {
    const r = mustRoll("1d20", rng);
    assert.ok(r.total >= 1 && r.total <= 20, `d20 produced ${r.total}`);
  }
});

test("a seed fully determines the sequence", () => {
  const a = mustRoll("8d10+5", makeRng("seed-abc"));
  const b = mustRoll("8d10+5", makeRng("seed-abc"));
  const c = mustRoll("8d10+5", makeRng("seed-xyz"));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.total === c.total && a.terms[0]!.rolls[0]!.value === c.terms[0]!.rolls[0]!.value, true);
});

test("d20 distribution covers the full face range", () => {
  const rng = makeRng("dist");
  const seen = new Set<number>();
  for (let i = 0; i < 5000; i++) seen.add(mustRoll("1d20", rng).total);
  assert.equal(seen.size, 20, `expected all 20 faces, saw ${seen.size}`);
});

test("malformed expressions return errors instead of throwing", () => {
  for (const bad of ["", "d", "2d", "abc", "1d20+", "+1d20", "-1d6", "1d20kh3", "2d6**2", "0d6", "1d0"]) {
    const r = roll(bad, fixed(1, 1, 1));
    assert.equal(r.ok, false, `expected "${bad}" to be rejected`);
  }
});

test("oversized requests are rejected rather than hanging", () => {
  assert.equal(roll("5000d6", fixed(1)).ok, false);
  assert.equal(roll("1d5000", fixed(1)).ok, false);
});

test("diceCount reports how many physical dice are needed", () => {
  const p = parseDice("2d6+1d8+3");
  assert.ok(p.ok);
  assert.equal(diceCount(p.value), 3);
});

test("range reports achievable bounds", () => {
  const p = parseDice("2d6+3");
  assert.ok(p.ok);
  assert.deepEqual(range(p.value), { min: 5, max: 15 });

  const k = parseDice("4d6kh3");
  assert.ok(k.ok);
  assert.deepEqual(range(k.value), { min: 3, max: 18 });
});

test("supplied physical dice are consumed in order", () => {
  const r = mustRoll("3d6", fixed(6, 1, 4));
  assert.deepEqual(r.terms[0]!.rolls.map((d) => d.value), [6, 1, 4]);
});

test("too few supplied dice raises a distinct error", () => {
  assert.throws(() => mustRoll("3d6", fixed(6, 1)), FixedRngExhausted);
});

test("whitespace and capitalisation are tolerated", () => {
  const a = mustRoll(" 2D6 + 3 ", fixed(4, 5));
  assert.equal(a.total, 12);
});

test("rollParsed is stable across repeated evaluation with equal seeds", () => {
  const p = parseDice("1d20+5");
  assert.ok(p.ok);
  const x = rollParsed(p.value, makeRng("k"));
  const y = rollParsed(p.value, makeRng("k"));
  assert.deepEqual(x, y);
});
