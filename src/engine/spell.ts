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
import { applyDamage, type DamageOutcome, type DamagePacket, type IgnoreResistance } from "./damage.ts";
import { effectsFor } from "./homebrew/active.ts";
import { contextOf, substituteNames } from "./homebrew/formula.ts";
import { gate } from "./homebrew/triggers.ts";
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
  /** The caster, so their homebrew (casts-spell, ignore resistance) applies. */
  readonly caster?: Combatant;
  /** Source tags on the spell's damage, e.g. "unphased". */
  readonly tags?: readonly string[];
  /** Optional homebrew effects the DM opts in to, by name. */
  readonly optIn?: readonly string[];
  /** Which target a single-target homebrew rider lands on; defaults to the first. */
  readonly effectTarget?: string;
  readonly turnId?: string;
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
  /** The caster after homebrew uses were spent. */
  readonly caster: Combatant | null;
  readonly effectNotes: readonly string[];
  readonly available: readonly string[];
  /** Homebrew riders rolled for one target only, outside the shared area roll. */
  readonly riderRolls: readonly { label: string; targetId: string; spec: SpellDamage; result: DiceResult }[];
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

  // Homebrew on the caster: riders when casting a spell of some damage type,
  // and resistance-ignoring that is not tied to a weapon.
  let caster = req.caster ?? null;
  const effectNotes: string[] = [];
  const available: string[] = [];
  const riderRolls: { label: string; targetId: string; spec: SpellDamage; result: DiceResult }[] = [];
  const ignoreResistance: IgnoreResistance[] = [];
  const tags = req.tags ?? [];
  const riderTargetId = req.effectTarget ?? req.targets[0]!.id;
  if (req.effectTarget !== undefined && !req.targets.some((t) => t.id === req.effectTarget)) {
    return err(`--effect-target "${req.effectTarget}" is not one of this spell's targets`);
  }
  if (caster !== null && basePackets.length > 0) {
    const types = [...new Set(req.damage.map((d) => d.type))];
    for (const live of effectsFor(caster, "casts-spell", { tags, types })) {
      const g = gate(live, caster, req.optIn ?? []);
      if (!g.use) {
        if (g.available) available.push(g.available);
        if (g.note) effectNotes.push(g.note);
        continue;
      }
      caster = g.holder;
      if (g.note) effectNotes.push(g.note);
      for (const a of live.effect.actions) {
        if (a.kind !== "add-damage") continue;
        const expr = substituteNames(a.expression, contextOf(caster));
        if (!expr.ok) return err(`${live.label}: ${expr.error}`);
        const parsedRider = parseDice(expr.value);
        if (!parsedRider.ok) return err(`${live.label}: ${parsedRider.error}`);
        const result = rollParsed(parsedRider.value, rng);
        riderRolls.push({ label: live.label, targetId: riderTargetId, spec: { expression: expr.value, type: a.type }, result });
        effectNotes.push(`${live.label}: +${expr.value} ${a.type} to ${req.targets.find((t) => t.id === riderTargetId)!.name} = ${result.total}`);
      }
    }
    for (const live of effectsFor(caster, "outgoing-damage", { tags })) {
      for (const a of live.effect.actions) {
        if (a.kind === "ignore-resistance") ignoreResistance.push({ types: live.effect.when?.type ?? "all", label: live.label });
      }
    }
  }

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

    // A rider becomes part of the spell's damage to its one target, so the
    // save treats it like the rest.
    const riders: DamagePacket[] = riderRolls
      .filter((r) => r.targetId === target.id)
      .map((r) => ({ amount: Math.max(0, r.result.total), type: r.spec.type }));
    const ownPackets = [...basePackets, ...riders];
    const halved = save.success && req.onSuccess === "half";
    const packets = halved
      ? ownPackets.map((p) => ({ ...p, amount: halve(p.amount) }))
      : ownPackets;

    return {
      targetId: target.id,
      targetName: target.name,
      save,
      damage: applyDamage(target, packets, {
        source: req.name, tags, ignoreResistance, rng,
        ...(req.turnId !== undefined ? { turnId: req.turnId } : {}),
      }),
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
    caster,
    effectNotes,
    available,
    riderRolls,
  });
}
