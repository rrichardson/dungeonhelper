/**
 * Saving throws and ability checks.
 *
 * Conditions that force an automatic failure short-circuit before any die is
 * rolled, so a paralyzed creature never appears to "roll" a Strength save.
 */

import type { Rng } from "./rng.ts";
import { rollD20, type D20Roll, type Modifier } from "./d20.ts";
import { CONDITIONS, effectiveConditions, exhaustionPenalty } from "./conditions.ts";
import { abilityModifier, type Ability, type Combatant } from "./types.ts";

export interface CheckRequest {
  readonly creature: Combatant;
  readonly ability: Ability;
  readonly dc: number;
  /** Add proficiency bonus — for skill checks and proficient saves. */
  readonly proficient?: boolean;
  /** Expertise doubles proficiency. */
  readonly expertise?: boolean;
  readonly extraBonus?: number;
  readonly advantage?: readonly string[];
  readonly disadvantage?: readonly string[];
  readonly label?: string;
}

export interface CheckOutcome {
  readonly label: string;
  readonly ability: Ability;
  readonly dc: number;
  readonly roll: D20Roll | null;
  readonly success: boolean;
  readonly autoFailed: boolean;
  readonly reason: string | null;
  readonly margin: number | null;
}

function baseModifiers(
  creature: Combatant,
  ability: Ability,
  proficient: boolean,
  expertise: boolean,
  extra: number,
): Modifier[] {
  const mods: Modifier[] = [
    { source: `${ability.toUpperCase()} mod`, value: abilityModifier(creature.abilities[ability]) },
  ];
  if (proficient) {
    const pb = creature.proficiencyBonus * (expertise ? 2 : 1);
    mods.push({ source: expertise ? "expertise" : "proficiency", value: pb });
  }
  const exhaustion = exhaustionPenalty(creature.exhaustion);
  if (exhaustion !== 0) {
    mods.push({ source: `exhaustion ${creature.exhaustion}`, value: exhaustion });
  }
  if (extra !== 0) mods.push({ source: "situational", value: extra });
  return mods;
}

/** A saving throw. Proficiency is taken from the stat block unless overridden. */
export function savingThrow(req: CheckRequest, rng: Rng): CheckOutcome {
  const { creature, ability, dc } = req;
  const label = req.label ?? `${ability.toUpperCase()} save`;

  const advantage = [...(req.advantage ?? [])];
  const disadvantage = [...(req.disadvantage ?? [])];

  for (const applied of effectiveConditions(creature.conditions)) {
    const effect = CONDITIONS[applied.condition];
    if (effect.autoFailSaves?.includes(ability)) {
      return {
        label, ability, dc, roll: null,
        success: false, autoFailed: true,
        reason: `automatic failure: ${applied.condition}`,
        margin: null,
      };
    }
    if (effect.disadvantageOnSaves?.includes(ability)) {
      disadvantage.push(`${applied.condition}`);
    }
  }

  const proficient = req.proficient ?? creature.saveProficiencies.includes(ability);
  const modifiers = baseModifiers(creature, ability, proficient, req.expertise ?? false, req.extraBonus ?? 0);
  const roll = rollD20({ modifiers, advantage, disadvantage }, rng);

  return {
    label, ability, dc, roll,
    success: roll.total >= dc,
    autoFailed: false,
    reason: null,
    margin: roll.total - dc,
  };
}

/** An ability check. Conditions that hamper checks apply automatically. */
export function abilityCheck(req: CheckRequest, rng: Rng): CheckOutcome {
  const { creature, ability, dc } = req;
  const label = req.label ?? `${ability.toUpperCase()} check`;

  const advantage = [...(req.advantage ?? [])];
  const disadvantage = [...(req.disadvantage ?? [])];

  for (const applied of effectiveConditions(creature.conditions)) {
    if (CONDITIONS[applied.condition].abilityChecksWithDisadvantage) {
      disadvantage.push(`${applied.condition}`);
    }
  }

  const modifiers = baseModifiers(
    creature, ability, req.proficient ?? false, req.expertise ?? false, req.extraBonus ?? 0,
  );
  const roll = rollD20({ modifiers, advantage, disadvantage }, rng);

  return {
    label, ability, dc, roll,
    success: roll.total >= dc,
    autoFailed: false,
    reason: null,
    margin: roll.total - dc,
  };
}

/** Concentration is a Constitution save, DC set by the damage taken. */
export function concentrationSave(
  creature: Combatant,
  dc: number,
  rng: Rng,
): CheckOutcome {
  return savingThrow(
    { creature, ability: "con", dc, label: `concentration (DC ${dc})` },
    rng,
  );
}
