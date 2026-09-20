/**
 * Normalizing an Open5e creature into a stat block the engine can run.
 *
 * Pure and total. Two quirks of the source are handled explicitly:
 *
 *  - `proficiency_bonus` is often null, so it is derived from challenge rating.
 *  - An attack's `damage_type` is sometimes null with the real type sitting in
 *    `extra_damage_type`, so both are consulted before giving up.
 *
 * Anything ambiguous becomes a warning rather than an invented number.
 */

import { type Json, arr, bool, isObject, num, obj, str } from "./ddb-shape.ts";
import { type Result, ok, err } from "../result.ts";
import {
  ABILITIES, CONDITION_NAMES, DAMAGE_TYPES, abilityModifier,
  type Ability, type Combatant, type ConditionName, type DamageType, type WeaponAttack,
} from "../types.ts";

const ABILITY_KEYS: Readonly<Record<Ability, string>> = {
  str: "strength", dex: "dexterity", con: "constitution",
  int: "intelligence", wis: "wisdom", cha: "charisma",
};

/** Proficiency bonus by challenge rating, per the monster rules. */
export function proficiencyForCr(cr: number): number {
  if (cr >= 29) return 9;
  if (cr >= 25) return 8;
  if (cr >= 21) return 7;
  if (cr >= 17) return 6;
  if (cr >= 13) return 5;
  if (cr >= 9) return 4;
  if (cr >= 5) return 3;
  return 2;
}

/** "3d6" → a hit dice pool. */
export function parseHitDice(text: string | undefined): { size: number; max: number } | null {
  if (text === undefined) return null;
  const m = /^\s*(\d+)\s*d\s*(\d+)/i.exec(text);
  if (!m) return null;
  return { max: Number(m[1]), size: Number(m[2]) };
}

function slug(name: string, key: string | undefined): string {
  const base = (key ?? name).replace(/^.*?_/, "");
  const cleaned = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "creature" : cleaned;
}

/** Entries may be plain strings or objects carrying `key` / `name`. */
function nameOf(entry: Json): string | undefined {
  if (typeof entry === "string") return entry;
  if (!isObject(entry)) return undefined;
  return str(entry, "key") ?? str(entry, "name");
}

function typedList<T extends string>(
  container: Json,
  field: string,
  allowed: readonly T[],
  warnings: string[],
  label: string,
): T[] {
  const out: T[] = [];
  for (const entry of arr(container, field)) {
    const raw = nameOf(entry);
    if (raw === undefined) continue;
    const lowered = raw.toLowerCase();
    if ((allowed as readonly string[]).includes(lowered)) out.push(lowered as T);
    else warnings.push(`${label} "${raw}" is not modelled by the engine and was dropped`);
  }
  return [...new Set(out)];
}

/** "D6" → 6. */
function dieSize(text: string | undefined): number | null {
  if (text === undefined) return null;
  const m = /^d?(\d+)$/i.exec(text.trim());
  return m ? Number(m[1]) : null;
}

function attacksFrom(creature: Json, warnings: string[]): WeaponAttack[] {
  const out: WeaponAttack[] = [];

  for (const action of arr(creature, "actions")) {
    const actionName = str(action, "name") ?? "attack";
    for (const attack of arr(action, "attacks")) {
      const toHit = num(attack, "to_hit_mod");
      const count = num(attack, "damage_die_count");
      const size = dieSize(str(attack, "damage_die_type") ?? undefined);
      const bonus = num(attack, "damage_bonus") ?? 0;

      if (toHit === undefined || count === undefined || size === null) {
        warnings.push(`"${actionName}" has no readable attack numbers and was skipped`);
        continue;
      }

      // The primary damage type is sometimes null with the real type recorded
      // as the extra damage type.
      const primary = nameOf(obj(attack, "damage_type") ?? null);
      const extra = nameOf(obj(attack, "extra_damage_type") ?? null);
      const typeName = (primary ?? extra)?.toLowerCase();

      if (typeName === undefined || !(DAMAGE_TYPES as readonly string[]).includes(typeName)) {
        warnings.push(`"${actionName}" has damage type "${typeName ?? "none"}" and was skipped`);
        continue;
      }

      // Conditional riders are not applied automatically: they depend on how
      // the roll came out. Open5e often leaves the structured extra-damage
      // fields null and states the rider only in the description, so the text
      // is checked too rather than trusting the structured fields alone.
      const describedRider = /\bplus\b[^.]*?\(\s*\d+d\d+[^)]*\)/i.test(str(action, "desc") ?? "");
      if (num(attack, "extra_damage_die_count") !== undefined || describedRider) {
        warnings.push(
          `"${actionName}" deals conditional extra damage that is not applied automatically — see the stat block text`,
        );
      }

      const reach = num(attack, "reach");
      const range = num(attack, "range");
      const expression = bonus === 0
        ? `${count}d${size}`
        : `${count}d${size}${bonus > 0 ? "+" : "-"}${Math.abs(bonus)}`;

      const longRange = num(attack, "long_range");
      const isMelee = range === undefined || range === null;

      out.push({
        name: actionName.toLowerCase(),
        bonus: toHit,
        damage: [{ expression, type: typeName as DamageType }],
        melee: isMelee ? true : reach !== undefined && reach !== null,
        ...(isMelee ? { range: reach ?? 5 } : { range }),
        ...(longRange !== undefined && longRange !== null ? { longRange } : {}),
        ...(!isMelee ? { note: `range ${range}/${longRange ?? range} ft` } : {}),
      });
    }
  }
  return out;
}

export interface Open5eImport {
  readonly combatant: Combatant;
  readonly source: string;
  readonly challengeRating: number;
  readonly warnings: readonly string[];
}

export function normalizeCreature(raw: Json): Result<Open5eImport, string> {
  if (!isObject(raw)) return err("Open5e payload is not an object");

  const name = str(raw, "name");
  if (name === undefined || name.trim() === "") return err("creature has no name");

  const scoresRaw = obj(raw, "ability_scores");
  if (!scoresRaw) return err(`"${name}" has no ability scores`);

  const warnings: string[] = [];
  const abilities = {} as Record<Ability, number>;
  for (const ability of ABILITIES) {
    const value = num(scoresRaw, ABILITY_KEYS[ability]);
    if (value === undefined) return err(`"${name}" is missing ${ABILITY_KEYS[ability]}`);
    abilities[ability] = value;
  }

  const ac = num(raw, "armor_class");
  const hp = num(raw, "hit_points");
  if (ac === undefined) return err(`"${name}" has no armor class`);
  if (hp === undefined) return err(`"${name}" has no hit points`);

  const cr = num(raw, "challenge_rating") ?? 0;
  const proficiencyBonus = num(raw, "proficiency_bonus") ?? proficiencyForCr(cr);

  // Save proficiency is not stated; it shows as a save bonus above the raw
  // ability modifier.
  const savesRaw = obj(raw, "saving_throws");
  const saveProficiencies: Ability[] = [];
  if (savesRaw) {
    for (const ability of ABILITIES) {
      const stated = num(savesRaw, ABILITY_KEYS[ability]);
      if (stated === undefined) continue;
      if (stated > abilityModifier(abilities[ability])) saveProficiencies.push(ability);
    }
  }

  const defences = obj(raw, "resistances_and_immunities") ?? {};
  const resistances = typedList<DamageType>(defences, "damage_resistances", DAMAGE_TYPES, warnings, "resistance");
  const immunities = typedList<DamageType>(defences, "damage_immunities", DAMAGE_TYPES, warnings, "immunity");
  const vulnerabilities = typedList<DamageType>(defences, "damage_vulnerabilities", DAMAGE_TYPES, warnings, "vulnerability");
  const conditionImmunities = typedList<ConditionName>(defences, "condition_immunities", CONDITION_NAMES, warnings, "condition immunity");

  const speed = num(obj(raw, "speed") ?? null, "walk") ?? 30;
  const hitDice = parseHitDice(str(raw, "hit_dice"));
  const attacks = attacksFrom(raw, warnings);
  if (attacks.length === 0) {
    warnings.push("no attacks could be derived; add them by hand before running combat");
  }

  const document = obj(raw, "document");
  const source = (document ? str(document, "display_name") ?? str(document, "name") : undefined) ?? "Open5e";

  const combatant: Combatant = {
    id: slug(name, str(raw, "key")),
    name,
    ac,
    hp: { current: hp, max: hp, temp: 0 },
    abilities,
    proficiencyBonus,
    saveProficiencies,
    speed,
    resistances,
    immunities,
    vulnerabilities,
    conditionImmunities,
    conditions: [],
    exhaustion: 0,
    concentration: null,
    deathSaves: { successes: 0, failures: 0 },
    stable: false,
    isPlayer: false,
    attacks,
    ...(hitDice !== null ? { hitDice: { size: hitDice.size, max: hitDice.max, used: 0 } } : {}),
    notes: `${str(obj(raw, "size") ?? null, "name") ?? "Medium"} ${str(obj(raw, "type") ?? null, "name") ?? "creature"} · CR ${cr} · ${source}`,
  };

  return ok({ combatant, source, challengeRating: cr, warnings });
}

export { bool };
