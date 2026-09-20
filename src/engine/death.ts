/**
 * Death saving throws.
 *
 * A flat DC 10 d20 test with no ability modifier. Three successes stabilise;
 * three failures kill; a natural 20 restores one hit point and a natural 1
 * counts as two failures.
 */

import type { Rng } from "./rng.ts";
import { rollD20, type D20Roll, type Modifier } from "./d20.ts";
import { exhaustionPenalty } from "./conditions.ts";
import type { Combatant } from "./types.ts";
import { type Result, ok, err } from "./result.ts";

export const DEATH_SAVE_DC = 10;

export type DeathSaveEffect = "none" | "stabilised" | "dead" | "revived";

export interface DeathSaveOutcome {
  readonly roll: D20Roll;
  readonly success: boolean;
  readonly criticalSuccess: boolean;
  readonly criticalFailure: boolean;
  readonly successesAdded: number;
  readonly failuresAdded: number;
  readonly effect: DeathSaveEffect;
  readonly combatant: Combatant;
  readonly notes: readonly string[];
}

export function rollDeathSave(
  creature: Combatant,
  rng: Rng,
): Result<DeathSaveOutcome, string> {
  if (creature.hp.current > 0) {
    return err(`${creature.name} is not at 0 hit points`);
  }
  if (creature.deathSaves.failures >= 3) {
    return err(`${creature.name} is already dead`);
  }
  if (creature.stable) {
    return err(`${creature.name} is stable and does not roll death saves`);
  }

  const modifiers: Modifier[] = [];
  const exhaustion = exhaustionPenalty(creature.exhaustion);
  if (exhaustion !== 0) {
    modifiers.push({ source: `exhaustion ${creature.exhaustion}`, value: exhaustion });
  }

  const roll = rollD20({ modifiers, advantage: [], disadvantage: [] }, rng);
  const notes: string[] = [];

  // A natural 20 restores a hit point outright, ending the dying state.
  if (roll.natural20) {
    notes.push("natural 20: regains 1 hit point and is conscious");
    return {
      ok: true,
      value: {
        roll, success: true, criticalSuccess: true, criticalFailure: false,
        successesAdded: 0, failuresAdded: 0, effect: "revived",
        combatant: {
          ...creature,
          hp: { ...creature.hp, current: 1 },
          deathSaves: { successes: 0, failures: 0 },
          stable: false,
          conditions: creature.conditions.filter((c) => c.condition !== "unconscious"),
        },
        notes,
      },
    };
  }

  const criticalFailure = roll.natural1;
  const success = !criticalFailure && roll.total >= DEATH_SAVE_DC;
  const successesAdded = success ? 1 : 0;
  const failuresAdded = success ? 0 : criticalFailure ? 2 : 1;
  if (criticalFailure) notes.push("natural 1: counts as two failures");

  const successes = Math.min(3, creature.deathSaves.successes + successesAdded);
  const failures = Math.min(3, creature.deathSaves.failures + failuresAdded);

  let effect: DeathSaveEffect = "none";
  if (failures >= 3) {
    effect = "dead";
    notes.push("three failures: dead");
  } else if (successes >= 3) {
    effect = "stabilised";
    notes.push("three successes: stable, no longer rolls death saves");
  }

  return ok({
    roll, success, criticalSuccess: false, criticalFailure,
    successesAdded, failuresAdded, effect,
    combatant: {
      ...creature,
      deathSaves: { successes, failures },
      stable: effect === "stabilised",
    },
    notes,
  });
}

/** Stabilise without a roll — a successful Medicine check or healer's kit. */
export function stabilise(creature: Combatant): Result<Combatant, string> {
  if (creature.hp.current > 0) return err(`${creature.name} is not dying`);
  if (creature.deathSaves.failures >= 3) return err(`${creature.name} is dead`);
  return ok({
    ...creature,
    stable: true,
    deathSaves: { successes: 0, failures: 0 },
  });
}
