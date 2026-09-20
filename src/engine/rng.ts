/**
 * Deterministic, seeded randomness.
 *
 * Every roll the engine makes draws from an Rng passed in by the caller, so
 * engine functions stay pure with respect to a given Rng. A seed string fully
 * determines the sequence, which is what makes any roll at the table
 * reproducible after the fact.
 */

export interface Rng {
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
}

/** Raised when a caller supplies fewer physical die results than were needed. */
export class FixedRngExhausted extends Error {
  readonly consumed: number;
  constructor(consumed: number) {
    super(`ran out of supplied die results after ${consumed}`);
    this.name = "FixedRngExhausted";
    this.consumed = consumed;
  }
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough for dice, and fully reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An Rng whose entire sequence is determined by `seed`. */
export function makeRng(seed: string): Rng {
  const next = mulberry32(fnv1a(seed));
  return {
    int(min: number, max: number): number {
      if (max < min) [min, max] = [max, min];
      return min + Math.floor(next() * (max - min + 1));
    },
  };
}

/**
 * An Rng that replays results the DM supplies — for physical dice at the
 * table, and for tests that need an exact sequence. Values are consumed in
 * order and clamped into each die's legal range.
 */
export function makeFixedRng(values: readonly number[]): Rng {
  let i = 0;
  return {
    int(min: number, max: number): number {
      if (max < min) [min, max] = [max, min];
      if (i >= values.length) throw new FixedRngExhausted(i);
      const raw = values[i++]!;
      return Math.min(max, Math.max(min, Math.trunc(raw)));
    },
  };
}
