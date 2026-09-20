/**
 * Spell effects resolved by saving throw, including area effects.
 *
 * Two rules drive the shape of this module:
 *
 *  - Area damage is rolled ONCE and the same total applies to every creature
 *    in the area. Re-rolling per target is a common table error and produces
 *    noticeably different results across a big fireball.
 *
 *  - A successful save halves damage before resistance is considered. Both
 *    reductions apply and compound, so a resistant creature that saves takes a
 *    quarter of the rolled damage, not half.
 *
 * Pure: damage is computed but concentration checks are returned for the
 * caller to roll, as everywhere else in the engine.
 */

import type { Rng } from "./rng.ts";
import { type Result, ok, err } from "./result.ts";
import { parseDice, rollParsed, type DiceResult } from "./dice.ts";
import { savingThrow, type CheckOutcome } from "./checks.ts";
import { applyDamage, type DamageOutcome, type DamagePacket } from "./damage.ts";
import type { Ability, Combatant, DamageType } from "./types.ts";

/** What a successful saving throw achieves. */
export type SaveEffect = "half" | "none";

export interface SpellDamage {
  readonly expression: string;
  readonly type: DamageType;
}

export interface SpellRequest {
  readonly name: string;
  readonly dc: number;
  readonly ability: Ability;
  /** Empty for a spell that deals no damage, such as Hold Person. */
  readonly damage: readonly SpellDamage[];
  /** Whether a successful save halves the damage or avoids it entirely. */
  readonly onSuccess: SaveEffect;
  readonly targets: readonly Combatant[];
}

export interface SpellTargetOutcome {
  readonly targetId: string;
  readonly targetName: string;
  readonly save: CheckOutcome;
  /** Damage after the save was applied, or null when nothing was dealt. */
  readonly damage: DamageOutcome | null;
  readonly halved: boolean;
  readonly avoided: boolean;
}

export interface SpellOutcome {
  readonly name: string;
  readonly dc: number;
  readonly ability: Ability;
  /** The single shared damage roll, rolled once for the whole area. */
  readonly damageRolls: readonly { spec: SpellDamage; result: DiceResult }[];
  readonly baseTotal: number;
  readonly targets: readonly SpellTargetOutcome[];
}

/** Halve and round down, the 5e convention for a successful save. */
function halve(amount: number): number {
  return Math.floor(amount / 2);
}

export function resolveSpell(req: SpellRequest, rng: Rng): Result<SpellOutcome, string> {
  if (req.targets.length === 0) return err("a spell needs at least one target");

  const seen = new Set<string>();
  for (const t of req.targets) {
    if (seen.has(t.id)) return err(`"${t.id}" is listed twice as a target`);
    seen.add(t.id);
  }

  // Parse every expression before rolling, so a typo costs no dice.
  const parsed = [];
  for (const spec of req.damage) {
    const p = parseDice(spec.expression);
    if (!p.ok) return err(`damage "${spec.expression}": ${p.error}`);
    parsed.push({ spec, parsed: p.value });
  }

  // Rolled once, shared by every creature in the area.
  const damageRolls = parsed.map(({ spec, parsed: p }) => ({
    spec,
    result: rollParsed(p, rng),
  }));
  const basePackets: DamagePacket[] = damageRolls.map(({ spec, result }) => ({
    amount: Math.max(0, result.total),
    type: spec.type,
  }));
  const baseTotal = basePackets.reduce((sum, p) => sum + p.amount, 0);

  const targets: SpellTargetOutcome[] = req.targets.map((target) => {
    const save = savingThrow(
      { creature: target, ability: req.ability, dc: req.dc, label: `${req.ability.toUpperCase()} save vs ${req.name}` },
      rng,
    );

    if (basePackets.length === 0) {
      return {
        targetId: target.id, targetName: target.name, save,
        damage: null, halved: false, avoided: false,
      };
    }

    const avoided = save.success && req.onSuccess === "none";
    if (avoided) {
      return {
        targetId: target.id, targetName: target.name, save,
        damage: null, halved: false, avoided: true,
      };
    }

    const halved = save.success && req.onSuccess === "half";
    const packets = halved
      ? basePackets.map((p) => ({ ...p, amount: halve(p.amount) }))
      : basePackets;

    return {
      targetId: target.id,
      targetName: target.name,
      save,
      damage: applyDamage(target, packets, { source: req.name }),
      halved,
      avoided: false,
    };
  });

  return ok({
    name: req.name,
    dc: req.dc,
    ability: req.ability,
    damageRolls,
    baseTotal,
    targets,
  });
}
