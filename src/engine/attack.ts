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
import { applyDamage, type DamageOutcome, type DamagePacket, type IgnoreResistance } from "./damage.ts";
import {
  acBonus, attackBonusFor, attackTags, creatureTags, critRangeFor, damageBonusFor, effectsFor,
} from "./homebrew/active.ts";
import { contextOf, substituteNames } from "./homebrew/formula.ts";
import { fire, gate } from "./homebrew/triggers.ts";
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
  /**
   * True for a melee attack, false for a ranged one. Used as the adjacency
   * fallback when no `distance` is given, and always used to decide whether
   * the "ranged attack while threatened" penalty applies.
   */
  readonly within5: boolean;
  /** Distance to the target in feet, when the DM is tracking positions. */
  readonly distance?: number;
  /** Melee reach, or a ranged weapon's normal range. */
  readonly range?: number;
  readonly longRange?: number;
  /** A hostile creature is within 5 feet of the attacker. */
  readonly threatened?: boolean;
  readonly cover?: Cover;
  /** Lowest natural roll that crits; 20 unless a feature lowers it. */
  readonly critRange?: number;
  readonly advantage?: readonly string[];
  readonly disadvantage?: readonly string[];
  /** Set false when the attacker cannot see the source of its fear. */
  readonly fearSourceVisible?: boolean;
  /** Resolve the attack even if the attacker is incapacitated. */
  readonly force?: boolean;
  /** Source tags the DM attaches, e.g. "unphased" for a gravity attack. */
  readonly tags?: readonly string[];
  /** Names of optional ("may") homebrew effects the DM chooses to use. */
  readonly optIn?: readonly string[];
  /** Whose turn it is, for durations such as "until the end of its next turn". */
  readonly turnId?: string;
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
  /** The attacker after homebrew triggers (uses spent, temp HP gained). */
  readonly attacker: Combatant;
  /** The target after damage and homebrew triggers. */
  readonly target: Combatant;
  /** What each homebrew effect did, naming it. */
  readonly effectNotes: readonly string[];
  /** Optional effects that could have applied, with how to opt in. */
  readonly available: readonly string[];
}

export function resolveAttack(req: AttackRequest, rng: Rng): Result<AttackOutcome, string> {
  const cover = req.cover ?? "none";
  let critRange = req.critRange ?? 20;
  const notes: string[] = [];
  const effectNotes: string[] = [];
  const available: string[] = [];
  const optIn = req.optIn ?? [];
  let attacker = req.attacker;

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

  // Homebrew: the attacker's weapon numbers and outgoing effects, and the
  // target's AC. Worked out before any die is rolled.
  const tags = attackTags(req.attacker, req.weapon, req.tags ?? []);
  const match = { tags, targetTags: creatureTags(req.target), weapon: req.weapon };
  const atkBonus = attackBonusFor(req.attacker, req.weapon);
  const dmgBonus = damageBonusFor(req.attacker, req.weapon);
  const critGrant = critRangeFor(req.attacker, req.weapon);
  if (critGrant !== null && critGrant.value < critRange) {
    critRange = critGrant.value;
    effectNotes.push(`${critGrant.label}: crits on ${critRange}-20`);
  }

  let damageSpecs: DamageSpec[] = [...req.damage];
  if (dmgBonus.total !== 0 && damageSpecs.length > 0) {
    const first = damageSpecs[0]!;
    const sign = dmgBonus.total >= 0 ? "+" : "-";
    damageSpecs[0] = { ...first, expression: `${first.expression}${sign}${Math.abs(dmgBonus.total)}` };
    for (const p of dmgBonus.parts) effectNotes.push(`${p.label}: damage ${p.value >= 0 ? "+" : ""}${p.value}`);
  }

  const outgoing = effectsFor(req.attacker, "outgoing-damage", match);
  const ignoreResistance: IgnoreResistance[] = [];
  const pendingUses: typeof outgoing = [];
  for (const live of outgoing) {
    const g = gate(live, attacker, optIn);
    // Uses are only spent on a hit; here we only learn whether it may apply.
    if (!g.use) {
      if (g.available) available.push(g.available);
      if (g.note) effectNotes.push(g.note);
      continue;
    }
    if (live.resource !== null) pendingUses.push(live);
    for (const a of live.effect.actions) {
      if (a.kind === "add-damage") {
        const expr = substituteNames(a.expression, contextOf(req.attacker));
        if (!expr.ok) return err(`${live.label}: ${expr.error}`);
        damageSpecs = [...damageSpecs, { expression: expr.value, type: a.type }];
        effectNotes.push(`${live.label}: +${expr.value} ${a.type}`);
      }
      if (a.kind === "ignore-resistance") {
        ignoreResistance.push({ types: live.effect.when?.type ?? "all", label: live.label });
      }
    }
  }

  // Parse every damage expression up front so a typo fails before any dice are rolled.
  const parsedDamage = [];
  for (const spec of damageSpecs) {
    const parsed = parseDice(spec.expression);
    if (!parsed.ok) return err(`damage "${spec.expression}": ${parsed.error}`);
    parsedDamage.push({ spec, parsed: parsed.value });
  }

  // Distance, when given, decides adjacency — a bow fired from three feet is
  // still an attack from within 5 feet, and prone and auto-crit both care
  // about that rather than about what the attacker is holding.
  const within5 = req.distance !== undefined ? req.distance <= 5 : req.within5;

  const rangeNotes: string[] = [];
  const rangeDisadvantage: string[] = [];

  if (req.distance !== undefined) {
    const melee = req.within5 || req.range === undefined || req.longRange === undefined;
    if (melee) {
      const reach = req.range ?? 5;
      if (req.distance > reach && !req.force) {
        return err(
          `${req.target.name} is ${req.distance} ft away, beyond ${req.weapon}'s ${reach} ft reach`,
        );
      }
    } else {
      const normal = req.range!;
      const long = req.longRange!;
      if (req.distance > long && !req.force) {
        return err(
          `${req.target.name} is ${req.distance} ft away, beyond ${req.weapon}'s long range of ${long} ft`,
        );
      }
      if (req.distance > normal) {
        rangeDisadvantage.push(`long range (${req.distance} ft, normal ${normal} ft)`);
      }
    }
    rangeNotes.push(`distance ${req.distance} ft`);
  }

  // A ranged attack made with a hostile creature within 5 feet has
  // disadvantage. This turns on the kind of attack, not the distance to the
  // target: a bow fired point blank is still a ranged attack.
  if (req.threatened === true && !req.within5) {
    rangeDisadvantage.push("ranged attack with a hostile within 5 ft");
  }

  const derived = attackAdvantage(
    req.attacker,
    req.target,
    within5,
    req.fearSourceVisible ?? true,
  );
  const advantage = [...derived.advantage, ...(req.advantage ?? [])];
  const disadvantage = [...derived.disadvantage, ...rangeDisadvantage, ...(req.disadvantage ?? [])];

  const modifiers: Modifier[] = [{ source: "attack bonus", value: req.attackBonus }];
  for (const p of atkBonus.parts) modifiers.push({ source: p.label, value: p.value });
  const exhaustion = exhaustionPenalty(req.attacker.exhaustion);
  if (exhaustion !== 0) {
    modifiers.push({ source: `exhaustion ${req.attacker.exhaustion}`, value: exhaustion });
  }

  const roll = rollD20({ modifiers, advantage, disadvantage }, rng);

  const targetAc = acBonus(req.target);
  const baseAc = req.target.ac + targetAc.total;
  for (const p of targetAc.parts) effectNotes.push(`${p.label}: target AC ${p.value >= 0 ? "+" : ""}${p.value}`);
  const effectiveAc = baseAc + COVER_AC[cover];
  if (cover !== "none") notes.push(`${cover} cover: AC ${baseAc} → ${effectiveAc}`);
  for (const note of rangeNotes) notes.push(note);

  // A natural 20 always hits and always crits; a natural 1 always misses.
  const automatic = roll.natural20 ? "hit" : roll.natural1 ? "miss" : null;
  const hit = roll.natural20 ? true : roll.natural1 ? false : roll.total >= effectiveAc;

  const auto = hit ? autoCritApplies(req.target, within5) : null;
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
      attacker,
      target: req.target,
      effectNotes,
      available,
    });
  }

  for (const live of pendingUses) {
    const g = gate(live, attacker, optIn);
    if (g.use) {
      attacker = g.holder;
      if (g.note) effectNotes.push(g.note);
    }
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
    tags,
    ignoreResistance,
    rng,
    ...(req.turnId !== undefined ? { turnId: req.turnId } : {}),
  });

  let target = damage.combatant;
  const fireOpts = { rng, optIn, ...(req.turnId !== undefined ? { turnId: req.turnId } : {}) };
  if (critical) {
    const fired = fire("critical-hit", attacker, target, match, fireOpts);
    attacker = fired.holder;
    target = fired.other;
    effectNotes.push(...fired.lines);
    available.push(...fired.available);
  }
  if (damage.hpBefore > 0 && damage.hpAfter === 0) {
    const fired = fire("reduces-target-to-0", attacker, target, match, fireOpts);
    attacker = fired.holder;
    target = fired.other;
    effectNotes.push(...fired.lines);
    available.push(...fired.available);
  }

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
    attacker,
    target,
    effectNotes,
    available,
  });
}
