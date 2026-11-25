/**
 * Damage and healing application.
 *
 * Order of operations (2024): flat modifiers are already baked into the packet
 * amounts by the caller; this module applies, per packet, immunity, then
 * resistance / vulnerability, then any homebrew incoming-damage scale (such as
 * the Continuance's "Phased": one quarter, rounded down); then it sums the
 * packets, absorbs temp HP, and reduces hit points. A homebrew
 * would-drop-to-0 effect is checked last, after temp HP, because it replaces
 * the drop itself.
 *
 * Pure: it never rolls. When damage requires a concentration save it returns a
 * description of the check for the caller to resolve, rather than rolling one.
 */

import type { Combatant, DamageType } from "./types.ts";
import { effectiveConditions, CONDITIONS } from "./conditions.ts";
import type { Rng } from "./rng.ts";
import { makeFixedRng } from "./rng.ts";
import {
  appliesToType, damageTraits, effectsFor, remaining, spendUse, type DamageTraits,
} from "./homebrew/active.ts";
import { contextOf, evalFormula } from "./homebrew/formula.ts";
import { runActions } from "./homebrew/run.ts";

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
  /** Homebrew steps that changed this packet, in order, e.g. "Phased: ×1/4 (round down) 13 → 3". */
  readonly homebrew?: readonly string[];
}

/** Outgoing "ignore resistance" from the attacker's homebrew. */
export interface IgnoreResistance {
  /** Damage types it covers; "all" when the effect names no type. */
  readonly types: readonly DamageType[] | "all";
  readonly label: string;
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

function scaleBy(amount: number, num: number, den: number, round: "down" | "up" | "nearest"): number {
  const exact = (amount * num) / den;
  return round === "up" ? Math.ceil(exact) : round === "nearest" ? Math.round(exact) : Math.floor(exact);
}

function adjust(
  packet: DamagePacket,
  target: Combatant,
  resistAll: boolean,
  traits: DamageTraits,
  options: DamageOptions,
): AdjustedPacket {
  const amount = Math.max(0, Math.trunc(packet.amount));
  const homebrew: string[] = [];

  const immuneBy = target.immunities.includes(packet.type) ? null : traits.immune.get(packet.type);
  if (target.immunities.includes(packet.type) || immuneBy !== undefined) {
    if (immuneBy) homebrew.push(`${immuneBy}: immune to ${packet.type}`);
    return { type: packet.type, before: amount, after: 0, adjustment: "immune", ...(homebrew.length ? { homebrew } : {}) };
  }

  const resistBy = target.resistances.includes(packet.type) || resistAll
    ? null
    : traits.resistAll ?? traits.resist.get(packet.type) ?? null;
  let resistant = resistAll || target.resistances.includes(packet.type) || resistBy !== null;
  const ignored = (options.ignoreResistance ?? []).find((i) => i.types === "all" || i.types.includes(packet.type));
  if (resistant && ignored) {
    homebrew.push(`${ignored.label}: ignores resistance to ${packet.type}`);
    resistant = false;
  } else if (resistBy !== null) {
    homebrew.push(`${resistBy}: resistant to ${packet.type}`);
  }
  const vulnerableBy = target.vulnerabilities.includes(packet.type) ? null : traits.vulnerable.get(packet.type) ?? null;
  const vulnerable = target.vulnerabilities.includes(packet.type) || vulnerableBy !== null;
  if (vulnerableBy !== null) homebrew.push(`${vulnerableBy}: vulnerable to ${packet.type}`);

  let after = amount;
  let adjustment: DamageAdjustment = "normal";
  if (resistant && vulnerable) adjustment = "resist+vulnerable cancel";
  else if (resistant) { after = Math.floor(amount / 2); adjustment = "resistant"; }
  else if (vulnerable) { after = amount * 2; adjustment = "vulnerable"; }

  // Homebrew scaling comes after resistance and vulnerability.
  const ctx = { tags: options.tags ?? [] };
  for (const live of effectsFor(target, "incoming-damage", ctx)) {
    if (!appliesToType(live.effect, ctx, packet.type)) continue;
    for (const a of live.effect.actions) {
      if (a.kind !== "scale") continue;
      const scaled = scaleBy(after, a.num, a.den, a.round);
      homebrew.push(`${live.label}: ×${a.num}/${a.den} (round ${a.round}) ${after} → ${scaled}`);
      after = scaled;
    }
  }

  return { type: packet.type, before: amount, after, adjustment, ...(homebrew.length ? { homebrew } : {}) };
}

export interface DamageOptions {
  /** A critical hit causes two death save failures instead of one at 0 HP. */
  readonly critical?: boolean;
  readonly source?: string;
  /** Source tags on this damage, e.g. "unphased" for a gravity attack. */
  readonly tags?: readonly string[];
  /** The attacker's homebrew that ignores resistance for some types. */
  readonly ignoreResistance?: readonly IgnoreResistance[];
  /** Whose turn it is, so timed effects started here end on schedule. */
  readonly turnId?: string;
  /** Only needed if a triggered effect rolls; none on would-drop-to-0 does today. */
  readonly rng?: Rng;
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

  const traits = damageTraits(target);
  const adjusted = packets.map((p) => adjust(p, target, resistAll, traits, options));
  const rawTotal = adjusted.reduce((s, p) => s + p.before, 0);
  const adjustedTotal = adjusted.reduce((s, p) => s + p.after, 0);

  const hpBefore = target.hp.current;
  const wasAtZero = hpBefore <= 0;

  const tempAbsorbed = Math.min(target.hp.temp, adjustedTotal);
  const toHp = adjustedTotal - tempAbsorbed;
  let hpAfter = Math.max(0, hpBefore - toHp);

  // Homebrew "would drop to 0" replaces the drop, so it is checked before
  // massive damage and before anything that follows from reaching 0.
  // Temp HP is spent first, so anything a trigger grants lands on top of it.
  let base: Combatant = { ...target, hp: { ...target.hp, temp: target.hp.temp - tempAbsorbed } };
  let intercepted = false;
  if (!wasAtZero && hpAfter === 0 && toHp > 0) {
    for (const live of effectsFor(target, "would-drop-to-0", { tags: options.tags ?? [] })) {
      if (live.resource !== null) {
        const pool = base.resources?.[live.resource];
        if (!pool || remaining(pool) === 0) {
          notes.push(`${live.label}: would trigger, but no uses remain`);
          continue;
        }
        const spent = spendUse(base, live.resource);
        if (!spent.ok) continue;
        base = spent.value;
      }
      const setHp = live.effect.actions.find((a) => a.kind === "set-hp");
      const value = setHp && setHp.kind === "set-hp" ? evalFormula(setHp.amount, contextOf(target)) : null;
      const to = value && value.ok ? Math.max(1, Math.min(target.hp.max, value.value)) : 1;
      hpAfter = to;
      intercepted = true;
      notes.push(`${live.label}: instead of dropping to 0, ${target.name} drops to ${to} HP`);
      const pool = live.resource !== null ? base.resources?.[live.resource] : undefined;
      if (pool) notes.push(`${pool.label}: ${remaining(pool)}/${pool.max} uses left`);
      const ran = runActions(live.effect.actions, {
        holder: base, other: null, rng: options.rng ?? makeFixedRng([]), label: live.label,
        ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
      });
      if (ran.ok) {
        base = ran.value.holder;
        notes.push(...ran.value.lines);
      } else {
        notes.push(`${live.label}: ${ran.error}`);
      }
      break;
    }
  }
  const hpLost = hpBefore - hpAfter;

  // Massive damage: leftover damage after reaching 0 that meets or exceeds the
  // creature's hit point maximum kills outright.
  const overflow = toHp - Math.max(0, hpBefore);
  const instantDeath = !intercepted && toHp > 0 && overflow >= target.hp.max && target.hp.max > 0;
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
    ? base.conditions
    : droppedToZero && target.isPlayer
      ? [...base.conditions.filter((c) => c.condition !== "unconscious"),
         { condition: "unconscious" as const, note: "at 0 HP" }]
      : base.conditions;

  const next: Combatant = {
    ...base,
    hp: { ...base.hp, current: hpAfter, temp: base.hp.temp },
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
