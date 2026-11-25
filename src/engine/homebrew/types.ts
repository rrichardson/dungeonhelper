/**
 * Homebrew definitions, after validation. Authoring syntax is documented in
 * the dnd-campaign skill; schema.ts turns that syntax into these types.
 */

import type { Ability, ConditionName, DamageType } from "../types.ts";
import type { Formula } from "./formula.ts";

export type DefKind = "trait" | "item" | "weapon" | "armor" | "spell" | "effect";
export const DEF_KINDS: readonly DefKind[] = ["trait", "item", "weapon", "armor", "spell", "effect"];

/** When an effect is consulted. */
export type Hook =
  | "always"              // static while active
  | "incoming-damage"     // the holder is taking damage
  | "outgoing-damage"     // the holder is dealing damage
  | "critical-hit"        // the holder scores a critical hit
  | "reduces-target-to-0" // the holder's hit drops a creature to 0 HP
  | "would-drop-to-0"     // the holder is about to drop to 0 HP
  | "casts-spell";        // the holder casts a damaging spell
export const HOOKS: readonly Hook[] = [
  "always", "incoming-damage", "outgoing-damage", "critical-hit",
  "reduces-target-to-0", "would-drop-to-0", "casts-spell",
];

export type RestPeriod = "round" | "short-rest" | "long-rest" | "dawn";
export const REST_PERIODS: readonly RestPeriod[] = ["round", "short-rest", "long-rest", "dawn"];

export interface Condition {
  /** Source tags on the damage or attack, e.g. "unphased" passed with --tag. */
  readonly tag?: readonly string[];
  /** Creature tags on the target, e.g. "fungal". */
  readonly targetTag?: readonly string[];
  /** Damage type of the packet (or, for casts-spell, any type the spell deals). */
  readonly type?: readonly DamageType[];
  /** The attack is made with one of these named attacks. */
  readonly weapon?: readonly string[];
}

export type Until =
  | { readonly kind: "end-of-turn"; readonly whose: "holder" | "target" }
  | { readonly kind: "rounds"; readonly n: number };

/** Static numbers an effect can grant. Every field is additive or a set union. */
export interface Grant {
  readonly ac?: number;
  readonly speed?: number;
  readonly saveBonus?: Readonly<Partial<Record<Ability | "all", number>>>;
  readonly checkBonus?: Readonly<Partial<Record<Ability | "all", number>>>;
  readonly attackBonus?: number;
  readonly damageBonus?: number;
  /** Lowest natural d20 that crits. The lowest grant wins. */
  readonly critRange?: number;
  readonly resist?: readonly DamageType[];
  readonly immune?: readonly DamageType[];
  readonly vulnerable?: readonly DamageType[];
  readonly resistAll?: boolean;
}

export type Target = "self" | "target";

export type Action =
  | { readonly kind: "grant"; readonly grant: Grant; readonly until?: Until; readonly to: Target }
  | { readonly kind: "scale"; readonly num: number; readonly den: number; readonly round: "down" | "up" | "nearest" }
  | { readonly kind: "ignore-resistance" }
  | { readonly kind: "add-damage"; readonly expression: string; readonly type: DamageType }
  | {
      readonly kind: "saving-throw";
      readonly ability: Ability;
      readonly dc: Formula;
      readonly onFail: readonly Action[];
      readonly onSuccess: readonly Action[];
    }
  | { readonly kind: "condition"; readonly condition: ConditionName; readonly until?: Until; readonly to: Target }
  | { readonly kind: "temphp"; readonly amount: Formula; readonly to: Target }
  | { readonly kind: "set-hp"; readonly amount: Formula };

export interface UsesSpec {
  readonly max: Formula;
  readonly per: RestPeriod | "never";
  /** Regained each period: a fixed formula or a dice expression. Absent = all. */
  readonly regain?: { readonly dice: string } | { readonly formula: Formula };
}

export interface Effect {
  readonly name: string;
  readonly hook: Hook;
  readonly when?: Condition;
  readonly unless?: Condition;
  readonly actions: readonly Action[];
  /** Optional: the engine reports it; the DM opts in with --effect NAME. */
  readonly may: boolean;
  readonly uses?: UsesSpec;
}

/** Reference-only: tracked uses and rule text, never adjudicated. */
export interface Feature {
  readonly name: string;
  readonly text: string;
  readonly uses?: UsesSpec;
}

export interface AttackSpec {
  readonly name: string;
  readonly bonus: Formula;
  readonly damage: readonly { readonly expression: string; readonly type: DamageType }[];
  readonly melee: boolean;
  readonly range?: number;
  readonly longRange?: number;
}

export interface HomebrewDef {
  readonly id: string;
  readonly name: string;
  readonly kind: DefKind;
  readonly attunement: boolean;
  readonly text?: string;
  /** A weapon that takes over an attack already on the sheet, renaming it. */
  readonly replacesAttack?: string;
  /** A weapon that adds a new attack to the sheet. */
  readonly grantsAttack?: AttackSpec;
  /** Source tags every attack with this weapon carries. */
  readonly attackTags: readonly string[];
  /** Tags the holder gains as a creature (e.g. "fungal"). */
  readonly creatureTags: readonly string[];
  readonly effects: readonly Effect[];
  readonly features: readonly Feature[];
}

/** A definition attached to a creature, with how it got there. */
export interface Attached {
  readonly def: HomebrewDef;
  /** The authoring object, kept so the definition re-validates on every load. */
  readonly source: unknown;
  readonly attuned: boolean;
  readonly origin: "loadout" | "trait" | "attached";
  /** Wiki note the definition came from, for the log. */
  readonly note?: string;
  /** Loadout override: the sheet attack this weapon takes over. */
  readonly asAttack?: string;
  /** The original name of the sheet attack this weapon renamed, to undo it. */
  readonly replaced?: string;
}

/** A tracked pool of uses or charges, keyed "<def id>/<effect or feature>". */
export interface ResourcePool {
  readonly label: string;
  readonly max: number;
  readonly used: number;
  readonly per: RestPeriod | "never";
  readonly regain?: { readonly dice: string } | { readonly amount: number };
}

export type Expiry =
  | { readonly kind: "end-of-turn"; readonly of: string; readonly skip: number }
  | { readonly kind: "rounds"; readonly of: string; readonly remaining: number };

/** A temporary grant or condition living on the creature it affects. */
export interface Timed {
  readonly label: string;
  readonly grant?: Grant;
  readonly condition?: ConditionName;
  readonly expires: Expiry;
}
