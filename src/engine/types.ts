/** Core domain types. D&D 2024 rules (SRD 5.2). */

import type { Attached, ResourcePool, Timed } from "./homebrew/types.ts";

export type Ability = "str" | "dex" | "con" | "int" | "wis" | "cha";

export const ABILITIES: readonly Ability[] = ["str", "dex", "con", "int", "wis", "cha"];

export const ABILITY_NAMES: Record<Ability, string> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

export type DamageType =
  | "acid" | "bludgeoning" | "cold" | "fire" | "force" | "lightning"
  | "necrotic" | "piercing" | "poison" | "psychic" | "radiant"
  | "slashing" | "thunder";

export const DAMAGE_TYPES: readonly DamageType[] = [
  "acid", "bludgeoning", "cold", "fire", "force", "lightning",
  "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder",
];

export type ConditionName =
  | "blinded" | "charmed" | "deafened" | "frightened" | "grappled"
  | "incapacitated" | "invisible" | "paralyzed" | "petrified" | "poisoned"
  | "prone" | "restrained" | "stunned" | "unconscious";

export const CONDITION_NAMES: readonly ConditionName[] = [
  "blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated",
  "invisible", "paralyzed", "petrified", "poisoned", "prone", "restrained",
  "stunned", "unconscious",
];

export interface AppliedCondition {
  readonly condition: ConditionName;
  /** Combatant id that imposed it — matters for grappled and frightened. */
  readonly source?: string;
  /** Free-text note, e.g. "save ends at end of turn". */
  readonly note?: string;
}

export interface HitPoints {
  readonly current: number;
  readonly max: number;
  readonly temp: number;
}

export interface DeathSaves {
  readonly successes: number;
  readonly failures: number;
}

export interface SlotPool {
  readonly max: number;
  readonly used: number;
}

export interface HitDice {
  /** Die size, e.g. 8 for d8. Mixed-class characters use their largest. */
  readonly size: number;
  readonly max: number;
  readonly used: number;
}

export interface Concentration {
  readonly spell: string;
  /** Round the spell was cast, for tracking duration. */
  readonly since?: number;
}

/**
 * A named attack on a stat block. Reference data only — the engine never reads
 * it; the CLI uses it to fill in attack bonus and damage so the DM can name a
 * weapon instead of retyping its numbers.
 */
export interface WeaponAttack {
  readonly name: string;
  readonly bonus: number;
  readonly damage: readonly { readonly expression: string; readonly type: DamageType }[];
  readonly melee?: boolean;
  /** Melee reach, or a ranged weapon's normal range, in feet. */
  readonly range?: number;
  /** A ranged weapon's long range, in feet. Beyond it the shot is impossible. */
  readonly longRange?: number;
  readonly critRange?: number;
  readonly note?: string;
}

export interface Combatant {
  readonly id: string;
  readonly name: string;
  readonly ac: number;
  readonly hp: HitPoints;
  readonly abilities: Record<Ability, number>;
  readonly proficiencyBonus: number;
  readonly saveProficiencies: readonly Ability[];
  readonly speed: number;
  readonly resistances: readonly DamageType[];
  readonly immunities: readonly DamageType[];
  readonly vulnerabilities: readonly DamageType[];
  readonly conditionImmunities: readonly ConditionName[];
  readonly conditions: readonly AppliedCondition[];
  /** 2024 exhaustion: 0-6, where 6 is death. */
  readonly exhaustion: number;
  readonly concentration: Concentration | null;
  readonly deathSaves: DeathSaves;
  readonly stable: boolean;
  /** Player characters drop to 0 and make death saves; others are dispatched. */
  readonly isPlayer: boolean;
  readonly attacks?: readonly WeaponAttack[];
  /** Ability used for spell attack rolls and save DCs, when the creature casts. */
  readonly spellcastingAbility?: Ability;
  /** Spell slots by level, 1-9. Absent for creatures that cast none. */
  readonly spellSlots?: Readonly<Record<string, SlotPool>>;
  readonly hitDice?: HitDice;
  /** Attacks per Attack action: 2 with Extra Attack. Reference data for the DM. */
  readonly attacksPerAction?: number;
  /** Reactions refresh at the start of the creature's turn. */
  readonly reactionUsed?: boolean;
  readonly notes?: string;
  /** Creature tags homebrew effects can test, e.g. "fungal", "continuance". */
  readonly tags?: readonly string[];
  /** Levels by lowercase class name, for formulas like level(fighter). */
  readonly classLevels?: Readonly<Record<string, number>>;
  /** Total character level, when known. */
  readonly level?: number;
  /** Homebrew definitions attached to this creature: traits, items, effects. */
  readonly homebrew?: readonly Attached[];
  /** Uses and charges of homebrew effects and features, keyed "<def>/<name>". */
  readonly resources?: Readonly<Record<string, ResourcePool>>;
  /** Temporary grants and timed conditions from homebrew triggers. */
  readonly timed?: readonly Timed[];
}

/** Ability modifier: floor((score - 10) / 2). Handles odd and sub-10 scores. */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Effective max HP is unchanged by temp HP; temp is a separate pool absorbed first. */
export function isDown(c: Combatant): boolean {
  return c.hp.current <= 0;
}

export function isDead(c: Combatant): boolean {
  return c.exhaustion >= 6 || c.deathSaves.failures >= 3;
}

/**
 * Out of the fight for good: three death save failures, exhaustion 6, or a
 * non-player creature at 0 hit points.
 */
export function isDefeated(c: Combatant): boolean {
  return isDead(c) || (c.hp.current <= 0 && !c.isPlayer);
}

/** Spell save DC: 8 + proficiency bonus + spellcasting ability modifier. */
export function spellSaveDc(c: Combatant): number | null {
  if (c.spellcastingAbility === undefined) return null;
  return 8 + c.proficiencyBonus + abilityModifier(c.abilities[c.spellcastingAbility]);
}

export function hasCondition(c: Combatant, name: ConditionName): boolean {
  return c.conditions.some((a) => a.condition === name);
}
