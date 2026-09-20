/** Selection helpers for content generation. Pure given an Rng. */

import type { Rng } from "../rng.ts";

/** One entry of a table, with a relative weight. */
export interface Weighted<T> {
  readonly value: T;
  readonly weight: number;
}

export function pick<T>(items: readonly T[], rng: Rng): T {
  if (items.length === 0) throw new Error("pick() needs a non-empty list");
  return items[rng.int(0, items.length - 1)]!;
}

/** Pick by relative weight. Entries with weight <= 0 are never chosen. */
export function pickWeighted<T>(items: readonly Weighted<T>[], rng: Rng): T {
  const usable = items.filter((i) => i.weight > 0);
  if (usable.length === 0) throw new Error("pickWeighted() needs an entry with positive weight");

  const total = usable.reduce((sum, i) => sum + i.weight, 0);
  let roll = rng.int(1, total);
  for (const item of usable) {
    roll -= item.weight;
    if (roll <= 0) return item.value;
  }
  return usable[usable.length - 1]!.value;
}

/** `count` distinct entries, or every entry when the list is shorter. */
export function pickSome<T>(items: readonly T[], count: number, rng: Rng): T[] {
  const pool = [...items];
  const wanted = Math.min(Math.max(0, Math.trunc(count)), pool.length);
  const out: T[] = [];
  for (let i = 0; i < wanted; i++) {
    out.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]!);
  }
  return out;
}

export function chance(percent: number, rng: Rng): boolean {
  return rng.int(1, 100) <= percent;
}

/** A syllable-assembled name, so tables stay small but names stay varied. */
export function buildName(
  parts: { starts: readonly string[]; middles: readonly string[]; ends: readonly string[] },
  rng: Rng,
): string {
  const middle = chance(55, rng) ? pick(parts.middles, rng) : "";
  const raw = `${pick(parts.starts, rng)}${middle}${pick(parts.ends, rng)}`;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
