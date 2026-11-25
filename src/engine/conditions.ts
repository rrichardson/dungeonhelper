/**
 * Condition effects, D&D 2024 (SRD 5.2).
 *
 * Encoded as data so that attack, save and movement resolution read one table
 * rather than re-deriving the rules at each call site. Several conditions are
 * range- or source-dependent; those are expressed as tagged values rather than
 * booleans so callers must supply the context to resolve them.
 */

import type { Ability, ConditionName, Combatant, AppliedCondition } from "./types.ts";
import { speedBonus } from "./homebrew/active.ts";

/** "within5" / "beyond5" depend on attacker distance; true applies unconditionally. */
export type RangeQualified = boolean | "within5" | "beyond5";

export interface ConditionEffect {
  readonly summary: string;
  /** Cannot take actions, bonus actions or reactions; breaks concentration. */
  readonly incapacitated?: boolean;
  readonly speedZero?: boolean;
  readonly attackedWithAdvantage?: RangeQualified;
  readonly attackedWithDisadvantage?: RangeQualified;
  readonly attacksWithAdvantage?: boolean;
  readonly attacksWithDisadvantage?: boolean;
  /** Only applies to attacks against creatures other than the condition's source. */
  readonly attacksWithDisadvantageExceptSource?: boolean;
  /** Only applies while the source of the condition is visible to the sufferer. */
  readonly requiresVisibleSource?: boolean;
  readonly autoFailSaves?: readonly Ability[];
  readonly disadvantageOnSaves?: readonly Ability[];
  readonly abilityChecksWithDisadvantage?: boolean;
  /** Melee attacks that hit from within 5 feet are automatic critical hits. */
  readonly autoCritWithin5?: boolean;
  readonly resistAllDamage?: boolean;
  /** Conditions this one also imposes. */
  readonly implies?: readonly ConditionName[];
}

export const CONDITIONS: Record<ConditionName, ConditionEffect> = {
  blinded: {
    summary: "Can't see; auto-fails checks requiring sight.",
    attackedWithAdvantage: true,
    attacksWithDisadvantage: true,
  },
  charmed: {
    summary: "Can't harm the charmer; charmer has advantage on social checks.",
  },
  deafened: {
    summary: "Can't hear; auto-fails checks requiring hearing.",
  },
  frightened: {
    summary: "Disadvantage on checks and attacks while the source is in sight; can't move closer.",
    attacksWithDisadvantage: true,
    abilityChecksWithDisadvantage: true,
    requiresVisibleSource: true,
  },
  grappled: {
    summary: "Speed 0; disadvantage on attacks against anyone but the grappler.",
    speedZero: true,
    attacksWithDisadvantageExceptSource: true,
  },
  incapacitated: {
    summary: "No actions, bonus actions or reactions; concentration broken.",
    incapacitated: true,
  },
  invisible: {
    summary: "Attacks against have disadvantage; own attacks have advantage.",
    attackedWithDisadvantage: true,
    attacksWithAdvantage: true,
  },
  paralyzed: {
    summary: "Incapacitated, speed 0, auto-fails STR/DEX saves; melee hits within 5 ft crit.",
    incapacitated: true,
    speedZero: true,
    autoFailSaves: ["str", "dex"],
    attackedWithAdvantage: true,
    autoCritWithin5: true,
    implies: ["incapacitated"],
  },
  petrified: {
    summary: "Turned to stone: incapacitated, speed 0, resistant to all damage, auto-fails STR/DEX saves.",
    incapacitated: true,
    speedZero: true,
    autoFailSaves: ["str", "dex"],
    attackedWithAdvantage: true,
    resistAllDamage: true,
    implies: ["incapacitated"],
  },
  poisoned: {
    summary: "Disadvantage on attack rolls and ability checks.",
    attacksWithDisadvantage: true,
    abilityChecksWithDisadvantage: true,
  },
  prone: {
    summary: "Attacks against have advantage within 5 ft, disadvantage beyond; own attacks have disadvantage.",
    attackedWithAdvantage: "within5",
    attackedWithDisadvantage: "beyond5",
    attacksWithDisadvantage: true,
  },
  restrained: {
    summary: "Speed 0; attacks against have advantage; own attacks and DEX saves have disadvantage.",
    speedZero: true,
    attackedWithAdvantage: true,
    attacksWithDisadvantage: true,
    disadvantageOnSaves: ["dex"],
  },
  stunned: {
    summary: "Incapacitated, speed 0, auto-fails STR/DEX saves; attacks against have advantage.",
    incapacitated: true,
    speedZero: true,
    autoFailSaves: ["str", "dex"],
    attackedWithAdvantage: true,
    implies: ["incapacitated"],
  },
  unconscious: {
    summary: "Incapacitated, prone, speed 0, auto-fails STR/DEX saves; melee hits within 5 ft crit.",
    incapacitated: true,
    speedZero: true,
    autoFailSaves: ["str", "dex"],
    attackedWithAdvantage: true,
    autoCritWithin5: true,
    implies: ["incapacitated", "prone"],
  },
};

/**
 * Expand a creature's conditions to include everything they imply, so callers
 * never have to remember that unconscious carries prone and incapacitated.
 */
export function effectiveConditions(
  conditions: readonly AppliedCondition[],
): readonly AppliedCondition[] {
  const out = new Map<ConditionName, AppliedCondition>();
  const visit = (applied: AppliedCondition): void => {
    if (out.has(applied.condition)) return;
    out.set(applied.condition, applied);
    for (const implied of CONDITIONS[applied.condition].implies ?? []) {
      visit({ condition: implied, source: applied.source, note: `from ${applied.condition}` });
    }
  };
  for (const c of conditions) visit(c);
  return [...out.values()];
}

/** 2024 exhaustion: every level subtracts 2 from all d20 tests. */
export function exhaustionPenalty(level: number): number {
  return -2 * clampExhaustion(level);
}

/** 2024 exhaustion: every level subtracts 5 feet of speed. */
export function exhaustionSpeedPenalty(level: number): number {
  return -5 * clampExhaustion(level);
}

export function clampExhaustion(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(6, Math.trunc(level)));
}

/** Current walking speed after conditions and exhaustion. Never negative. */
export function effectiveSpeed(c: Combatant): number {
  const conditions = effectiveConditions(c.conditions);
  for (const applied of conditions) {
    if (CONDITIONS[applied.condition].speedZero) return 0;
  }
  return Math.max(0, c.speed + speedBonus(c).total + exhaustionSpeedPenalty(c.exhaustion));
}

/** Whether the creature can take actions at all. */
export function isIncapacitated(c: Combatant): boolean {
  return effectiveConditions(c.conditions).some(
    (a) => CONDITIONS[a.condition].incapacitated,
  );
}

/** Conditions a creature is immune to are silently refused, per the stat block. */
export function canApply(c: Combatant, condition: ConditionName): boolean {
  return !c.conditionImmunities.includes(condition);
}
