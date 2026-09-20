/** Core domain types. D&D 2024 rules (SRD 5.2). */

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
  /** Melee attacks default to being within 5 feet. */
  readonly melee?: boolean;
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
  readonly notes?: string;
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

export function hasCondition(c: Combatant, name: ConditionName): boolean {
  return c.conditions.some((a) => a.condition === name);
}
