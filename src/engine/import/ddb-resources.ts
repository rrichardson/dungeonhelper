/**
 * Spell slots and hit dice from a D&D Beyond payload.
 *
 * The payload's `spellSlots` / `pactMagic` arrays carry `available: 0` even
 * for characters who plainly have slots — D&D Beyond's own client computes the
 * maximum from the class table and uses those arrays only to record what has
 * been spent. So maximums come from `spellRules.levelSpellSlots[classLevel]`
 * and the arrays supply `used`.
 *
 * Pure.
 */

import { type Json, arr, num, obj, str } from "./ddb-shape.ts";
import type { HitDice, SlotPool } from "../types.ts";

const MAX_SPELL_LEVEL = 9;

interface CasterClass {
  readonly name: string;
  readonly level: number;
  /** Nine entries, one per spell level. */
  readonly slotsByLevel: readonly number[];
  readonly isPact: boolean;
}

function casterClasses(data: Json): CasterClass[] {
  const out: CasterClass[] = [];

  for (const c of arr(data, "classes")) {
    const definition = obj(c, "definition");
    if (!definition) continue;
    const level = num(c, "level") ?? 0;
    if (level <= 0) continue;

    const rules = obj(definition, "spellRules");
    if (!rules) continue;

    const table = arr(rules, "levelSpellSlots");
    const row = table[level];
    if (!Array.isArray(row)) continue;

    const slotsByLevel = row.map((v) => (typeof v === "number" ? v : 0));
    if (slotsByLevel.every((n) => n === 0)) continue;

    const name = str(definition, "name") ?? "(unknown class)";
    // A pact caster's slots are recorded separately from ordinary spell slots.
    out.push({ name, level, slotsByLevel, isPact: name.toLowerCase() === "warlock" });
  }
  return out;
}

/** Slots already spent, keyed by spell level. */
function usedByLevel(data: Json, key: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const entry of arr(data, key)) {
    const level = num(entry, "level");
    const used = num(entry, "used");
    if (level !== undefined && used !== undefined) out.set(level, used);
  }
  return out;
}

export function deriveSpellSlots(
  data: Json,
  warnings: string[],
): Record<string, SlotPool> | undefined {
  const casters = casterClasses(data);
  if (casters.length === 0) return undefined;

  if (casters.length > 1) {
    warnings.push(
      `multiclass spellcaster (${casters.map((c) => c.name).join(", ")}): slots were taken from ` +
        `${casters[0]!.name} alone, not the multiclass table — check them against the sheet`,
    );
  }

  const caster = casters[0]!;
  const used = usedByLevel(data, caster.isPact ? "pactMagic" : "spellSlots");

  const slots: Record<string, SlotPool> = {};
  for (let level = 1; level <= MAX_SPELL_LEVEL; level++) {
    const max = caster.slotsByLevel[level - 1] ?? 0;
    if (max <= 0) continue;
    slots[String(level)] = {
      max,
      used: Math.max(0, Math.min(max, used.get(level) ?? 0)),
    };
  }

  return Object.keys(slots).length > 0 ? slots : undefined;
}

/**
 * Hit dice. A multiclass character has a pool per class; the engine models one
 * pool, so the largest die is used and the mismatch is reported rather than
 * hidden.
 */
export function deriveHitDice(data: Json, warnings: string[]): HitDice | undefined {
  const pools: { size: number; level: number; used: number; name: string }[] = [];

  for (const c of arr(data, "classes")) {
    const definition = obj(c, "definition");
    if (!definition) continue;
    const size = num(definition, "hitDice");
    const level = num(c, "level") ?? 0;
    if (size === undefined || level <= 0) continue;
    pools.push({
      size,
      level,
      used: num(c, "hitDiceUsed") ?? 0,
      name: str(definition, "name") ?? "(unknown class)",
    });
  }

  if (pools.length === 0) return undefined;

  if (pools.length > 1) {
    const detail = pools.map((p) => `${p.level}d${p.size} ${p.name}`).join(" + ");
    warnings.push(
      `multiclass hit dice (${detail}) were merged into one pool of the largest die — spend them with that in mind`,
    );
  }

  const size = Math.max(...pools.map((p) => p.size));
  const max = pools.reduce((n, p) => n + p.level, 0);
  const used = pools.reduce((n, p) => n + p.used, 0);

  return { size, max, used: Math.max(0, Math.min(max, used)) };
}

/**
 * Extra attacks per Attack action. Both the martial "Extra Attack" feature and
 * the warlock invocation "Thirsting Blade" grant one.
 */
export function deriveAttacksPerAction(data: Json): { count: number; sources: string[] } {
  const sources: string[] = [];

  const consider = (name: string | undefined): void => {
    if (name === undefined) return;
    const lowered = name.toLowerCase();
    if (lowered.startsWith("extra attack") || lowered.startsWith("thirsting blade")) {
      sources.push(name);
    }
  };

  for (const c of arr(data, "classes")) {
    for (const f of arr(c, "classFeatures")) consider(str(obj(f, "definition"), "name"));
  }
  const options = obj(data, "options");
  if (options) {
    for (const key of Object.keys(options)) {
      for (const o of arr(options, key)) consider(str(obj(o, "definition"), "name"));
    }
  }
  for (const f of arr(data, "feats")) consider(str(obj(f, "definition"), "name"));

  // Each source grants one additional attack; they do not stack beyond that.
  return { count: sources.length > 0 ? 2 : 1, sources };
}


/**
 * Features that create attacks the payload cannot describe — a conjured pact
 * weapon has no inventory entry, so its attack has to be added by hand.
 */
export function unmodelledAttackFeatures(data: Json): string[] {
  const found: string[] = [];
  const consider = (name: string | undefined): void => {
    if (name === undefined) return;
    if (/^pact of the blade/i.test(name.trim())) found.push(name.trim());
  };

  const options = obj(data, "options");
  if (options) {
    for (const key of Object.keys(options)) {
      for (const o of arr(options, key)) consider(str(obj(o, "definition"), "name"));
    }
  }
  for (const c of arr(data, "classes")) {
    for (const f of arr(c, "classFeatures")) consider(str(obj(f, "definition"), "name"));
  }
  return [...new Set(found)];
}
