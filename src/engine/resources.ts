/**
 * Spell slots, hit dice and rests.
 *
 * Pure. Rest healing needs dice, so an Rng is injected exactly as elsewhere.
 */

import type { Rng } from "./rng.ts";
import { type Result, ok, err } from "./result.ts";
import { roll as rollExpression } from "./dice.ts";
import { clampExhaustion } from "./conditions.ts";
import { abilityModifier, type Combatant, type SlotPool } from "./types.ts";

export const MAX_SPELL_LEVEL = 9;

export interface SlotView {
  readonly level: number;
  readonly max: number;
  readonly used: number;
  readonly remaining: number;
}

export function slotsOf(c: Combatant): SlotView[] {
  const slots = c.spellSlots ?? {};
  const out: SlotView[] = [];
  for (let level = 1; level <= MAX_SPELL_LEVEL; level++) {
    const pool = slots[String(level)];
    if (!pool || pool.max <= 0) continue;
    out.push({
      level,
      max: pool.max,
      used: pool.used,
      remaining: Math.max(0, pool.max - pool.used),
    });
  }
  return out;
}

/** Spend one slot of the given level. Refuses rather than going negative. */
export function spendSlot(c: Combatant, level: number): Result<Combatant, string> {
  if (!Number.isInteger(level) || level < 1 || level > MAX_SPELL_LEVEL) {
    return err(`spell level must be 1-${MAX_SPELL_LEVEL}, got ${level}`);
  }
  const slots = c.spellSlots;
  const pool = slots?.[String(level)];
  if (!pool || pool.max <= 0) {
    return err(`${c.name} has no level ${level} spell slots`);
  }
  if (pool.used >= pool.max) {
    return err(`${c.name} has no level ${level} slots remaining (${pool.max} used of ${pool.max})`);
  }
  return ok({
    ...c,
    spellSlots: { ...slots, [String(level)]: { max: pool.max, used: pool.used + 1 } },
  });
}

/** Give back slots of one level, or all levels when `level` is null. */
export function restoreSlots(c: Combatant, level: number | null): Combatant {
  const slots = c.spellSlots;
  if (!slots) return c;

  if (level === null) {
    const restored: Record<string, SlotPool> = {};
    for (const [key, pool] of Object.entries(slots)) restored[key] = { max: pool.max, used: 0 };
    return { ...c, spellSlots: restored };
  }

  const pool = slots[String(level)];
  if (!pool) return c;
  return { ...c, spellSlots: { ...slots, [String(level)]: { max: pool.max, used: 0 } } };
}

export interface RestOutcome {
  readonly combatant: Combatant;
  readonly healed: number;
  readonly notes: readonly string[];
}

/**
 * A short rest. Hit dice are spent one at a time; each restores its roll plus
 * the Constitution modifier, to a minimum of 1 hit point.
 */
export function shortRest(
  c: Combatant,
  diceToSpend: number,
  rng: Rng,
): Result<RestOutcome, string> {
  const notes: string[] = [];
  const requested = Math.max(0, Math.trunc(diceToSpend));

  if (requested === 0) {
    return ok({ combatant: c, healed: 0, notes: ["no hit dice spent"] });
  }
  const hd = c.hitDice;
  if (!hd || hd.max <= 0) return err(`${c.name} has no hit dice recorded`);

  const available = Math.max(0, hd.max - hd.used);
  if (available === 0) return err(`${c.name} has no hit dice remaining`);

  const spending = Math.min(requested, available);
  if (spending < requested) notes.push(`only ${available} hit dice remained; spent ${spending}`);

  const conMod = abilityModifier(c.abilities.con);
  let healed = 0;
  for (let i = 0; i < spending; i++) {
    const result = rollExpression(`1d${hd.size}`, rng);
    if (!result.ok) return err(result.error);
    const gained = Math.max(1, result.value.total + conMod);
    healed += gained;
    notes.push(`d${hd.size}[${result.value.total}] ${conMod >= 0 ? "+" : "-"}${Math.abs(conMod)} CON = ${gained}`);
  }

  const hpAfter = Math.min(c.hp.max, c.hp.current + healed);
  const actual = hpAfter - c.hp.current;
  if (actual < healed) notes.push(`capped at HP max ${c.hp.max}`);

  return ok({
    combatant: {
      ...c,
      hp: { ...c.hp, current: hpAfter },
      hitDice: { ...hd, used: hd.used + spending },
    },
    healed: actual,
    notes,
  });
}

/**
 * A long rest: hit points to full, all spell slots back, half the hit dice
 * recovered (minimum one), and one level of exhaustion removed.
 */
export function longRest(c: Combatant): RestOutcome {
  const notes: string[] = [];
  const healed = c.hp.max - c.hp.current;
  if (healed > 0) notes.push(`hit points restored to ${c.hp.max}`);

  let hitDice = c.hitDice;
  if (hitDice && hitDice.used > 0) {
    const recovered = Math.min(hitDice.used, Math.max(1, Math.floor(hitDice.max / 2)));
    hitDice = { ...hitDice, used: hitDice.used - recovered };
    notes.push(`recovered ${recovered} hit dice`);
  }

  const withSlots = restoreSlots(c, null);
  if ((c.spellSlots && slotsOf(c).some((s) => s.used > 0))) notes.push("all spell slots restored");

  const exhaustion = clampExhaustion(c.exhaustion);
  if (exhaustion > 0) notes.push(`exhaustion ${exhaustion} → ${exhaustion - 1}`);

  return {
    combatant: {
      ...withSlots,
      hp: { ...c.hp, current: c.hp.max, temp: 0 },
      hitDice,
      exhaustion: Math.max(0, exhaustion - 1),
      deathSaves: { successes: 0, failures: 0 },
      stable: false,
      conditions: c.conditions.filter((a) => a.condition !== "unconscious"),
    },
    healed: Math.max(0, healed),
    notes,
  };
}
