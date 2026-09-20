/**
 * Initiative rolling and turn order.
 *
 * 2024 folds surprise into initiative: a creature that is incapacitated when
 * initiative is rolled has disadvantage, and one that is invisible has
 * advantage. Ties break on Dexterity modifier, then on a recorded tiebreak
 * value so the order stays stable and reproducible from the seed.
 */

import type { Rng } from "./rng.ts";
import { rollD20, type D20Roll } from "./d20.ts";
import { CONDITIONS, effectiveConditions, exhaustionPenalty } from "./conditions.ts";
import { abilityModifier, type Combatant } from "./types.ts";

export interface InitiativeEntry {
  readonly id: string;
  readonly name: string;
  readonly total: number;
  readonly dexMod: number;
  /** Recorded random value used only to break exact ties. */
  readonly tiebreak: number;
  readonly roll: D20Roll | null;
}

export interface InitiativeOptions {
  /** Fixed initiative for a creature the DM has already placed. */
  readonly fixed?: number;
  readonly advantage?: readonly string[];
  readonly disadvantage?: readonly string[];
  readonly bonus?: number;
}

export function rollInitiative(
  creature: Combatant,
  rng: Rng,
  options: InitiativeOptions = {},
): InitiativeEntry {
  const dexMod = abilityModifier(creature.abilities.dex);

  if (options.fixed !== undefined) {
    return {
      id: creature.id,
      name: creature.name,
      total: options.fixed,
      dexMod,
      tiebreak: rng.int(1, 1000),
      roll: null,
    };
  }

  const advantage = [...(options.advantage ?? [])];
  const disadvantage = [...(options.disadvantage ?? [])];

  for (const applied of effectiveConditions(creature.conditions)) {
    const effect = CONDITIONS[applied.condition];
    // Surprise, 2024: state when initiative is rolled shifts the roll itself.
    if (effect.incapacitated) disadvantage.push(`${applied.condition} at initiative`);
    if (applied.condition === "invisible") advantage.push("invisible at initiative");
  }

  const modifiers = [{ source: "DEX mod", value: dexMod }];
  const exhaustion = exhaustionPenalty(creature.exhaustion);
  if (exhaustion !== 0) {
    modifiers.push({ source: `exhaustion ${creature.exhaustion}`, value: exhaustion });
  }
  if (options.bonus) modifiers.push({ source: "bonus", value: options.bonus });

  const roll = rollD20({ modifiers, advantage, disadvantage }, rng);

  return {
    id: creature.id,
    name: creature.name,
    total: roll.total,
    dexMod,
    tiebreak: rng.int(1, 1000),
    roll,
  };
}

/** Highest initiative first; ties fall to Dexterity, then the recorded tiebreak. */
export function sortInitiative(
  entries: readonly InitiativeEntry[],
): readonly InitiativeEntry[] {
  return [...entries].sort(
    (a, b) =>
      b.total - a.total ||
      b.dexMod - a.dexMod ||
      b.tiebreak - a.tiebreak ||
      a.id.localeCompare(b.id),
  );
}
