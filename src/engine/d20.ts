/**
 * The d20 Test — the single roll underneath attacks, saves and ability checks.
 *
 * Advantage handling follows the 2024 rule exactly: if a roll has at least one
 * source of advantage and at least one of disadvantage, they cancel and the
 * roll is made normally, no matter how many sources sit on each side.
 */

import type { Rng } from "./rng.ts";

export type AdvantageState = "normal" | "advantage" | "disadvantage";

export interface Modifier {
  readonly source: string;
  readonly value: number;
}

export interface D20Input {
  readonly modifiers: readonly Modifier[];
  readonly advantage: readonly string[];
  readonly disadvantage: readonly string[];
}

export interface AdvantageResolution {
  readonly state: AdvantageState;
  readonly advantage: readonly string[];
  readonly disadvantage: readonly string[];
  /** True when both sides were present and cancelled out. */
  readonly cancelled: boolean;
}

export interface D20Roll {
  /** Every d20 face rolled, in order. Two entries under advantage/disadvantage. */
  readonly dice: readonly number[];
  readonly used: number;
  readonly resolution: AdvantageResolution;
  readonly modifiers: readonly Modifier[];
  readonly modifierTotal: number;
  readonly total: number;
  readonly natural20: boolean;
  readonly natural1: boolean;
}

export function resolveAdvantage(
  advantage: readonly string[],
  disadvantage: readonly string[],
): AdvantageResolution {
  const hasAdv = advantage.length > 0;
  const hasDis = disadvantage.length > 0;
  if (hasAdv && hasDis) {
    return { state: "normal", advantage, disadvantage, cancelled: true };
  }
  if (hasAdv) return { state: "advantage", advantage, disadvantage, cancelled: false };
  if (hasDis) return { state: "disadvantage", advantage, disadvantage, cancelled: false };
  return { state: "normal", advantage, disadvantage, cancelled: false };
}

/** How many d20s a test will consume — lets the CLI validate supplied physical dice. */
export function d20DiceNeeded(state: AdvantageState): number {
  return state === "normal" ? 1 : 2;
}

export function rollD20(input: D20Input, rng: Rng): D20Roll {
  const resolution = resolveAdvantage(input.advantage, input.disadvantage);
  const count = d20DiceNeeded(resolution.state);

  const dice: number[] = [];
  for (let i = 0; i < count; i++) dice.push(rng.int(1, 20));

  const used =
    resolution.state === "advantage"
      ? Math.max(...dice)
      : resolution.state === "disadvantage"
        ? Math.min(...dice)
        : dice[0]!;

  const modifiers = input.modifiers.filter((m) => m.value !== 0);
  const modifierTotal = modifiers.reduce((sum, m) => sum + m.value, 0);

  return {
    dice,
    used,
    resolution,
    modifiers,
    modifierTotal,
    total: used + modifierTotal,
    natural20: used === 20,
    natural1: used === 1,
  };
}

/** Render a roll as an auditable one-liner, e.g. "d20: [14, 7]→14 +5 = 19". */
export function describeD20(roll: D20Roll): string {
  const faces =
    roll.dice.length > 1 ? `[${roll.dice.join(", ")}]→${roll.used}` : `[${roll.used}]`;
  const mods = roll.modifiers
    .map((m) => `${m.value >= 0 ? "+" : "-"}${Math.abs(m.value)} ${m.source}`)
    .join(" ");
  const tag =
    roll.resolution.state === "advantage"
      ? " adv"
      : roll.resolution.state === "disadvantage"
        ? " dis"
        : roll.resolution.cancelled
          ? " (adv/dis cancelled)"
          : "";
  return `d20${tag}: ${faces}${mods ? " " + mods : ""} = ${roll.total}`;
}
