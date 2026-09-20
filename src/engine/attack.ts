/**
 * Attack resolution: to-hit, criticals, and damage.
 *
 * Advantage and disadvantage are derived from the combatants' conditions
 * rather than supplied by the caller, so the table's state decides the roll.
 * The DM can still add reasons explicitly for circumstances the sheet can't
 * know about (cover, spells, terrain, inspiration).
 */

import type { Rng } from "./rng.ts";
import { type Result, ok, err } from "./result.ts";
import { parseDice, rollParsed, doubleDice, type DiceResult } from "./dice.ts";
import { rollD20, type D20Roll, type Modifier } from "./d20.ts";
import { applyDamage, type DamageOutcome, type DamagePacket } from "./damage.ts";
import { CONDITIONS, effectiveConditions, exhaustionPenalty, isIncapacitated } from "./conditions.ts";
import { isDefeated, type Combatant, type DamageType } from "./types.ts";

export type Cover = "none" | "half" | "three-quarters" | "total";

const COVER_AC: Record<Cover, number> = {
  none: 0,
  half: 2,
  "three-quarters": 5,
  total: 0,
};

export interface DamageSpec {
  readonly expression: string;
  readonly type: DamageType;
}

export interface AttackRequest {
  readonly attacker: Combatant;
  readonly target: Combatant;
  /** Name of the attack, for the log. */
  readonly weapon: string;
  /** Total to-hit bonus: ability modifier + proficiency + magic. */
  readonly attackBonus: number;
  readonly damage: readonly DamageSpec[];
  /** Melee reach or adjacency — governs prone and the auto-crit rules. */
  readonly within5: boolean;
  readonly cover?: Cover;
  /** Lowest natural roll that crits; 20 unless a feature lowers it. */
  readonly critRange?: number;
  readonly advantage?: readonly string[];
  readonly disadvantage?: readonly string[];
  /** Set false when the attacker cannot see the source of its fear. */
  readonly fearSourceVisible?: boolean;
  /** Resolve the attack even if the attacker is incapacitated. */
  readonly force?: boolean;
}

export interface AttackAdvantage {
  readonly advantage: readonly string[];
  readonly disadvantage: readonly string[];
}

/** Derive advantage and disadvantage from both combatants' conditions. */
export function attackAdvantage(
  attacker: Combatant,
  target: Combatant,
  within5: boolean,
  fearSourceVisible = true,
): AttackAdvantage {
  const advantage: string[] = [];
  const disadvantage: string[] = [];

  for (const applied of effectiveConditions(attacker.conditions)) {
    const effect = CONDITIONS[applied.condition];
    const label = `attacker ${applied.condition}`;

    if (effect.requiresVisibleSource && !fearSourceVisible) continue;

    if (effect.attacksWithAdvantage) advantage.push(label);
    if (effect.attacksWithDisadvantage) disadvantage.push(label);
    if (effect.attacksWithDisadvantageExceptSource && applied.source !== target.id) {
      disadvantage.push(`${label} (target is not the grappler)`);
    }
  }

  for (const applied of effectiveConditions(target.conditions)) {
    const effect = CONDITIONS[applied.condition];
    const label = `target ${applied.condition}`;

    const adv = effect.attackedWithAdvantage;
    if (adv === true || (adv === "within5" && within5)) advantage.push(label);

    const dis = effect.attackedWithDisadvantage;
    if (dis === true || (dis === "beyond5" && !within5)) disadvantage.push(label);
  }

  return { advantage, disadvantage };
}

/** Whether a hit is automatically a critical because of the target's state. */
export function autoCritApplies(target: Combatant, within5: boolean): string | null {
  if (!within5) return null;
  for (const applied of effectiveConditions(target.conditions)) {
    if (CONDITIONS[applied.condition].autoCritWithin5) {
      return `target ${applied.condition} within 5 ft`;
    }
  }
  return null;
}

export interface AttackOutcome {
  readonly weapon: string;
  readonly attackerId: string;
  readonly targetId: string;
  readonly roll: D20Roll;
  readonly effectiveAc: number;
  readonly cover: Cover;
  readonly hit: boolean;
  readonly critical: boolean;
  readonly criticalReason: string | null;
  readonly automatic: "hit" | "miss" | null;
  readonly damageRolls: readonly { spec: DamageSpec; result: DiceResult }[];
  readonly damage: DamageOutcome | null;
  readonly notes: readonly string[];
}

export function resolveAttack(req: AttackRequest, rng: Rng): Result<AttackOutcome, string> {
  const cover = req.cover ?? "none";
  const critRange = req.critRange ?? 20;
  const notes: string[] = [];

  if (cover === "total") {
    return err(`${req.target.name} has total cover and cannot be targeted`);
  }
  if (isDefeated(req.target) && !req.force) {
    return err(`${req.target.name} is already out of the fight (pass force to override)`);
  }
  if (isIncapacitated(req.attacker) && !req.force) {
    return err(
      `${req.attacker.name} is incapacitated and cannot take actions (pass force to override)`,
    );
  }

  // Parse every damage expression up front so a typo fails before any dice are rolled.
  const parsedDamage = [];
  for (const spec of req.damage) {
    const parsed = parseDice(spec.expression);
    if (!parsed.ok) return err(`damage "${spec.expression}": ${parsed.error}`);
    parsedDamage.push({ spec, parsed: parsed.value });
  }

  const derived = attackAdvantage(
    req.attacker,
    req.target,
    req.within5,
    req.fearSourceVisible ?? true,
  );
  const advantage = [...derived.advantage, ...(req.advantage ?? [])];
  const disadvantage = [...derived.disadvantage, ...(req.disadvantage ?? [])];

  const modifiers: Modifier[] = [{ source: "attack bonus", value: req.attackBonus }];
  const exhaustion = exhaustionPenalty(req.attacker.exhaustion);
  if (exhaustion !== 0) {
    modifiers.push({ source: `exhaustion ${req.attacker.exhaustion}`, value: exhaustion });
  }

  const roll = rollD20({ modifiers, advantage, disadvantage }, rng);

  const effectiveAc = req.target.ac + COVER_AC[cover];
  if (cover !== "none") notes.push(`${cover} cover: AC ${req.target.ac} → ${effectiveAc}`);

  // A natural 20 always hits and always crits; a natural 1 always misses.
  const automatic = roll.natural20 ? "hit" : roll.natural1 ? "miss" : null;
  const hit = roll.natural20 ? true : roll.natural1 ? false : roll.total >= effectiveAc;

  const auto = hit ? autoCritApplies(req.target, req.within5) : null;
  const inCritRange = roll.used >= critRange;
  const critical = hit && (inCritRange || auto !== null);
  const criticalReason = !critical
    ? null
    : auto !== null
      ? auto
      : roll.used === 20
        ? "natural 20"
        : `natural ${roll.used} within crit range ${critRange}+`;

  if (!hit) {
    return ok({
      weapon: req.weapon,
      attackerId: req.attacker.id,
      targetId: req.target.id,
      roll,
      effectiveAc,
      cover,
      hit: false,
      critical: false,
      criticalReason: null,
      automatic,
      damageRolls: [],
      damage: null,
      notes,
    });
  }

  const damageRolls = parsedDamage.map(({ spec, parsed }) => ({
    spec,
    result: rollParsed(critical ? doubleDice(parsed) : parsed, rng),
  }));

  const packets: DamagePacket[] = damageRolls.map(({ spec, result }) => ({
    amount: Math.max(0, result.total),
    type: spec.type,
  }));

  const damage = applyDamage(req.target, packets, {
    critical,
    source: req.attacker.name,
  });

  return ok({
    weapon: req.weapon,
    attackerId: req.attacker.id,
    targetId: req.target.id,
    roll,
    effectiveAc,
    cover,
    hit: true,
    critical,
    criticalReason,
    automatic,
    damageRolls,
    damage,
    notes,
  });
}
