/**
 * Damage and healing application.
 *
 * Order of operations (2024): flat modifiers are already baked into the packet
 * amounts by the caller; this module applies immunity, then resistance /
 * vulnerability, then absorbs temp HP, then reduces hit points.
 *
 * Pure: it never rolls. When damage requires a concentration save it returns a
 * description of the check for the caller to resolve, rather than rolling one.
 */

import type { Combatant, DamageType } from "./types.ts";
import { effectiveConditions, CONDITIONS } from "./conditions.ts";

export interface DamagePacket {
  readonly amount: number;
  readonly type: DamageType;
}

export type DamageAdjustment =
  | "normal"
  | "immune"
  | "resistant"
  | "vulnerable"
  | "resist+vulnerable cancel";

export interface AdjustedPacket {
  readonly type: DamageType;
  readonly before: number;
  readonly after: number;
  readonly adjustment: DamageAdjustment;
}

export interface ConcentrationCheck {
  readonly dc: number;
  readonly spell: string;
  readonly reason: string;
}

export interface DamageOutcome {
  readonly combatant: Combatant;
  readonly packets: readonly AdjustedPacket[];
  readonly rawTotal: number;
  readonly adjustedTotal: number;
  readonly tempAbsorbed: number;
  readonly hpLost: number;
  readonly hpBefore: number;
  readonly hpAfter: number;
  readonly droppedToZero: boolean;
  readonly instantDeath: boolean;
  readonly deathSaveFailuresAdded: number;
  readonly died: boolean;
  readonly concentrationCheck: ConcentrationCheck | null;
  readonly notes: readonly string[];
}

function adjust(
  packet: DamagePacket,
  target: Combatant,
  resistAll: boolean,
): AdjustedPacket {
  const amount = Math.max(0, Math.trunc(packet.amount));

  if (target.immunities.includes(packet.type)) {
    return { type: packet.type, before: amount, after: 0, adjustment: "immune" };
  }

  const resistant = resistAll || target.resistances.includes(packet.type);
  const vulnerable = target.vulnerabilities.includes(packet.type);

  if (resistant && vulnerable) {
    return {
      type: packet.type,
      before: amount,
      after: amount,
      adjustment: "resist+vulnerable cancel",
    };
  }
  if (resistant) {
    return {
      type: packet.type,
      before: amount,
      after: Math.floor(amount / 2),
      adjustment: "resistant",
    };
  }
  if (vulnerable) {
    return { type: packet.type, before: amount, after: amount * 2, adjustment: "vulnerable" };
  }
  return { type: packet.type, before: amount, after: amount, adjustment: "normal" };
}

export interface DamageOptions {
  /** A critical hit causes two death save failures instead of one at 0 HP. */
  readonly critical?: boolean;
  readonly source?: string;
}

export function applyDamage(
  target: Combatant,
  packets: readonly DamagePacket[],
  options: DamageOptions = {},
): DamageOutcome {
  const notes: string[] = [];

  const resistAll = effectiveConditions(target.conditions).some(
    (a) => CONDITIONS[a.condition].resistAllDamage,
  );
  if (resistAll) notes.push("petrified: resistant to all damage");

  const adjusted = packets.map((p) => adjust(p, target, resistAll));
  const rawTotal = adjusted.reduce((s, p) => s + p.before, 0);
  const adjustedTotal = adjusted.reduce((s, p) => s + p.after, 0);

  const hpBefore = target.hp.current;
  const wasAtZero = hpBefore <= 0;

  const tempAbsorbed = Math.min(target.hp.temp, adjustedTotal);
  const toHp = adjustedTotal - tempAbsorbed;
  const hpAfter = Math.max(0, hpBefore - toHp);
  const hpLost = hpBefore - hpAfter;

  // Massive damage: leftover damage after reaching 0 that meets or exceeds the
  // creature's hit point maximum kills outright.
  const overflow = toHp - Math.max(0, hpBefore);
  const instantDeath = toHp > 0 && overflow >= target.hp.max && target.hp.max > 0;
  if (instantDeath) {
    notes.push(`massive damage: ${overflow} past 0 meets HP max ${target.hp.max}`);
  }

  const droppedToZero = !wasAtZero && hpAfter === 0 && toHp > 0;

  // Damage to a creature already at 0 HP causes death save failures.
  let deathSaveFailuresAdded = 0;
  if (wasAtZero && toHp > 0 && target.isPlayer && !instantDeath) {
    deathSaveFailuresAdded = options.critical ? 2 : 1;
    notes.push(
      `damage at 0 HP: ${deathSaveFailuresAdded} death save failure${deathSaveFailuresAdded > 1 ? "s" : ""}`,
    );
  }

  const failures = Math.min(3, target.deathSaves.failures + deathSaveFailuresAdded);
  const died = instantDeath || failures >= 3 || (hpAfter === 0 && !target.isPlayer && toHp > 0);

  // Concentration breaks on incapacitation or death; otherwise it is a save.
  let concentrationCheck: ConcentrationCheck | null = null;
  if (target.concentration && adjustedTotal > 0 && !died) {
    concentrationCheck = {
      dc: Math.max(10, Math.floor(adjustedTotal / 2)),
      spell: target.concentration.spell,
      reason: `took ${adjustedTotal} damage`,
    };
  }
  if (target.concentration && died) {
    notes.push(`concentration on ${target.concentration.spell} ends`);
  }

  const conditions = died && target.isPlayer
    ? target.conditions
    : droppedToZero && target.isPlayer
      ? [...target.conditions.filter((c) => c.condition !== "unconscious"),
         { condition: "unconscious" as const, note: "at 0 HP" }]
      : target.conditions;

  const next: Combatant = {
    ...target,
    hp: { ...target.hp, current: hpAfter, temp: target.hp.temp - tempAbsorbed },
    conditions,
    concentration: died ? null : target.concentration,
    deathSaves: { ...target.deathSaves, failures },
    stable: droppedToZero ? false : target.stable,
  };

  return {
    combatant: next,
    packets: adjusted,
    rawTotal,
    adjustedTotal,
    tempAbsorbed,
    hpLost,
    hpBefore,
    hpAfter,
    droppedToZero,
    instantDeath,
    deathSaveFailuresAdded,
    died,
    concentrationCheck,
    notes,
  };
}

export interface HealOutcome {
  readonly combatant: Combatant;
  readonly healed: number;
  readonly hpBefore: number;
  readonly hpAfter: number;
  readonly revived: boolean;
  readonly notes: readonly string[];
}

/** Healing a creature at 0 HP revives it: death saves reset and it wakes. */
export function applyHealing(target: Combatant, amount: number): HealOutcome {
  const notes: string[] = [];
  const requested = Math.max(0, Math.trunc(amount));
  const hpBefore = target.hp.current;
  const hpAfter = Math.min(target.hp.max, hpBefore + requested);
  const healed = hpAfter - hpBefore;
  const revived = hpBefore <= 0 && hpAfter > 0;

  if (healed < requested) notes.push(`capped at HP max ${target.hp.max}`);
  if (revived) notes.push("revived: death saves reset, no longer unconscious");

  return {
    combatant: {
      ...target,
      hp: { ...target.hp, current: hpAfter },
      deathSaves: revived ? { successes: 0, failures: 0 } : target.deathSaves,
      stable: revived ? false : target.stable,
      conditions: revived
        ? target.conditions.filter((c) => c.condition !== "unconscious")
        : target.conditions,
    },
    healed,
    hpBefore,
    hpAfter,
    revived,
    notes,
  };
}

/** Temporary HP never stacks — the larger pool wins, the other is discarded. */
export function applyTempHp(
  target: Combatant,
  amount: number,
): { combatant: Combatant; applied: boolean; note: string } {
  const offered = Math.max(0, Math.trunc(amount));
  if (offered <= target.hp.temp) {
    return {
      combatant: target,
      applied: false,
      note: `kept existing ${target.hp.temp} temp HP (offered ${offered}; temp HP does not stack)`,
    };
  }
  return {
    combatant: { ...target, hp: { ...target.hp, temp: offered } },
    applied: true,
    note: `temp HP ${target.hp.temp} → ${offered}`,
  };
}
