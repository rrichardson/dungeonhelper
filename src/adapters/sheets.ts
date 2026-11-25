/**
 * Loading and validating stat blocks from JSON.
 *
 * Validation is total and reports the exact field at fault — these files are
 * written by hand at the table, so a typo must produce a usable message rather
 * than a stack trace or, worse, a silently wrong number.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { type Result, ok, err } from "../engine/result.ts";
import { parseHomebrewFields } from "../engine/homebrew/persist.ts";
import {
  ABILITIES, DAMAGE_TYPES, CONDITION_NAMES,
  type Ability, type AppliedCondition, type Combatant, type DamageType,
  type ConditionName, type WeaponAttack, type SlotPool, type HitDice,
} from "../engine/types.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function num(o: Obj, key: string, where: string, fallback?: number): Result<number, string> {
  const v = o[key];
  if (v === undefined) {
    if (fallback !== undefined) return ok(fallback);
    return err(`${where}: missing required number "${key}"`);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return err(`${where}: "${key}" must be a number, got ${JSON.stringify(v)}`);
  }
  return ok(v);
}

function str(o: Obj, key: string, where: string, fallback?: string): Result<string, string> {
  const v = o[key];
  if (v === undefined) {
    if (fallback !== undefined) return ok(fallback);
    return err(`${where}: missing required string "${key}"`);
  }
  if (typeof v !== "string" || v.trim() === "") {
    return err(`${where}: "${key}" must be a non-empty string`);
  }
  return ok(v);
}

function enumList<T extends string>(
  o: Obj, key: string, allowed: readonly T[], where: string,
): Result<T[], string> {
  const v = o[key];
  if (v === undefined) return ok([]);
  if (!Array.isArray(v)) return err(`${where}: "${key}" must be an array`);
  const out: T[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      return err(
        `${where}: "${key}" contains ${JSON.stringify(item)}; allowed values are ${allowed.join(", ")}`,
      );
    }
    out.push(item as T);
  }
  return ok(out);
}

function parseAbilities(o: Obj, where: string): Result<Record<Ability, number>, string> {
  const raw = o["abilities"];
  if (!isObj(raw)) return err(`${where}: "abilities" must be an object with str/dex/con/int/wis/cha`);
  const out = {} as Record<Ability, number>;
  for (const ability of ABILITIES) {
    const v = raw[ability];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return err(`${where}: abilities.${ability} must be a number`);
    }
    if (v < 1 || v > 30) return err(`${where}: abilities.${ability} of ${v} is outside 1-30`);
    out[ability] = v;
  }
  return ok(out);
}

function parseAttacks(o: Obj, where: string): Result<WeaponAttack[], string> {
  const raw = o["attacks"];
  if (raw === undefined) return ok([]);
  if (!Array.isArray(raw)) return err(`${where}: "attacks" must be an array`);

  const out: WeaponAttack[] = [];
  for (const [i, item] of raw.entries()) {
    const at = `${where}: attacks[${i}]`;
    if (!isObj(item)) return err(`${at} must be an object`);

    const name = str(item, "name", at);
    if (!name.ok) return name;
    const bonus = num(item, "bonus", at);
    if (!bonus.ok) return bonus;

    const dmgRaw = item["damage"];
    if (!Array.isArray(dmgRaw) || dmgRaw.length === 0) {
      return err(`${at}: "damage" must be a non-empty array of {expression, type}`);
    }
    const damage: { expression: string; type: DamageType }[] = [];
    for (const [j, d] of dmgRaw.entries()) {
      const dat = `${at}.damage[${j}]`;
      if (!isObj(d)) return err(`${dat} must be an object`);
      const expression = str(d, "expression", dat);
      if (!expression.ok) return expression;
      const type = d["type"];
      if (typeof type !== "string" || !DAMAGE_TYPES.includes(type as DamageType)) {
        return err(`${dat}: "type" must be one of ${DAMAGE_TYPES.join(", ")}`);
      }
      damage.push({ expression: expression.value, type: type as DamageType });
    }

    out.push({
      name: name.value,
      bonus: bonus.value,
      damage,
      melee: item["melee"] === undefined ? true : item["melee"] === true,
      ...(typeof item["range"] === "number" ? { range: item["range"] } : {}),
      ...(typeof item["longRange"] === "number" ? { longRange: item["longRange"] } : {}),
      ...(typeof item["critRange"] === "number" ? { critRange: item["critRange"] } : {}),
      ...(typeof item["note"] === "string" ? { note: item["note"] } : {}),
    });
  }
  return ok(out);
}

/**
 * Conditions arrive in two shapes: bare names in hand-written stat blocks
 * ("prone"), and applied objects when state is read back from disk
 * ({condition, source}). Both are accepted so a sheet round-trips unchanged.
 */
function parseConditions(o: Obj, where: string): Result<AppliedCondition[], string> {
  const raw = o["conditions"];
  if (raw === undefined) return ok([]);
  if (!Array.isArray(raw)) return err(`${where}: "conditions" must be an array`);

  const out: AppliedCondition[] = [];
  for (const [i, item] of raw.entries()) {
    const at = `${where}: conditions[${i}]`;
    const name = typeof item === "string" ? item : isObj(item) ? item["condition"] : undefined;
    if (typeof name !== "string" || !CONDITION_NAMES.includes(name as ConditionName)) {
      return err(
        `${at}: expected a condition name or {condition}; allowed names are ${CONDITION_NAMES.join(", ")}`,
      );
    }
    const source = isObj(item) && typeof item["source"] === "string" ? item["source"] : undefined;
    const note = isObj(item) && typeof item["note"] === "string" ? item["note"] : undefined;
    out.push({
      condition: name as ConditionName,
      ...(source !== undefined ? { source } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }
  return ok(out);
}

/** Spell slots as {"1": {"max": 4, "used": 1}, ...}. */
function parseSlots(o: Obj, where: string): Result<Record<string, SlotPool> | undefined, string> {
  const raw = o["spellSlots"];
  if (raw === undefined) return ok(undefined);
  if (!isObj(raw)) return err(`${where}: "spellSlots" must be an object keyed by level`);

  const out: Record<string, SlotPool> = {};
  for (const [key, value] of Object.entries(raw)) {
    const level = Number(key);
    if (!Number.isInteger(level) || level < 1 || level > 9) {
      return err(`${where}: spellSlots key "${key}" must be a level 1-9`);
    }
    if (!isObj(value)) return err(`${where}: spellSlots.${key} must be {max, used}`);
    const max = num(value, "max", `${where}: spellSlots.${key}`);
    if (!max.ok) return max;
    const used = num(value, "used", `${where}: spellSlots.${key}`, 0);
    if (!used.ok) return used;
    if (max.value < 0) return err(`${where}: spellSlots.${key}.max cannot be negative`);
    out[key] = { max: max.value, used: Math.max(0, Math.min(max.value, used.value)) };
  }
  return ok(out);
}

function parseHitDice(o: Obj, where: string): Result<HitDice | undefined, string> {
  const raw = o["hitDice"];
  if (raw === undefined) return ok(undefined);
  if (!isObj(raw)) return err(`${where}: "hitDice" must be {size, max, used}`);
  const size = num(raw, "size", `${where}: hitDice`);
  if (!size.ok) return size;
  const max = num(raw, "max", `${where}: hitDice`);
  if (!max.ok) return max;
  const used = num(raw, "used", `${where}: hitDice`, 0);
  if (!used.ok) return used;
  if (size.value < 1) return err(`${where}: hitDice.size must be a positive die size`);
  return ok({
    size: size.value,
    max: Math.max(0, max.value),
    used: Math.max(0, Math.min(Math.max(0, max.value), used.value)),
  });
}

/** Parse one stat block. `where` names the file for error messages. */
export function parseCombatant(value: unknown, where: string): Result<Combatant, string> {
  if (!isObj(value)) return err(`${where}: expected a JSON object`);

  const id = str(value, "id", where);
  if (!id.ok) return id;
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id.value)) {
    return err(`${where}: "id" must be alphanumeric with dashes or underscores (got "${id.value}")`);
  }

  const name = str(value, "name", where, id.value);
  if (!name.ok) return name;
  const ac = num(value, "ac", where);
  if (!ac.ok) return ac;

  const hpRaw = value["hp"];
  if (!isObj(hpRaw)) return err(`${where}: "hp" must be an object like {"max": 31, "current": 31}`);
  const max = num(hpRaw, "max", `${where}: hp`);
  if (!max.ok) return max;
  if (max.value < 1) return err(`${where}: hp.max must be at least 1`);
  const current = num(hpRaw, "current", `${where}: hp`, max.value);
  if (!current.ok) return current;
  const temp = num(hpRaw, "temp", `${where}: hp`, 0);
  if (!temp.ok) return temp;

  const abilities = parseAbilities(value, where);
  if (!abilities.ok) return abilities;

  const proficiencyBonus = num(value, "proficiencyBonus", where, 2);
  if (!proficiencyBonus.ok) return proficiencyBonus;
  const speed = num(value, "speed", where, 30);
  if (!speed.ok) return speed;
  const exhaustion = num(value, "exhaustion", where, 0);
  if (!exhaustion.ok) return exhaustion;

  const saveProficiencies = enumList<Ability>(value, "saveProficiencies", ABILITIES, where);
  if (!saveProficiencies.ok) return saveProficiencies;
  const resistances = enumList<DamageType>(value, "resistances", DAMAGE_TYPES, where);
  if (!resistances.ok) return resistances;
  const immunities = enumList<DamageType>(value, "immunities", DAMAGE_TYPES, where);
  if (!immunities.ok) return immunities;
  const vulnerabilities = enumList<DamageType>(value, "vulnerabilities", DAMAGE_TYPES, where);
  if (!vulnerabilities.ok) return vulnerabilities;
  const conditionImmunities = enumList<ConditionName>(value, "conditionImmunities", CONDITION_NAMES, where);
  if (!conditionImmunities.ok) return conditionImmunities;
  const conditions = parseConditions(value, where);
  if (!conditions.ok) return conditions;

  const attacks = parseAttacks(value, where);
  if (!attacks.ok) return attacks;

  const spellSlots = parseSlots(value, where);
  if (!spellSlots.ok) return spellSlots;
  const hitDice = parseHitDice(value, where);
  if (!hitDice.ok) return hitDice;

  const rawCastingAbility = value["spellcastingAbility"];
  if (rawCastingAbility !== undefined
      && (typeof rawCastingAbility !== "string"
          || !ABILITIES.includes(rawCastingAbility as Ability))) {
    return err(`${where}: "spellcastingAbility" must be one of ${ABILITIES.join(", ")}`);
  }

  const homebrew = parseHomebrewFields(value, where);
  if (!homebrew.ok) return homebrew;

  return ok({
    ...homebrew.value,
    id: id.value,
    name: name.value,
    ac: ac.value,
    hp: { current: current.value, max: max.value, temp: temp.value },
    abilities: abilities.value,
    proficiencyBonus: proficiencyBonus.value,
    saveProficiencies: saveProficiencies.value,
    speed: speed.value,
    resistances: resistances.value,
    immunities: immunities.value,
    vulnerabilities: vulnerabilities.value,
    conditionImmunities: conditionImmunities.value,
    conditions: conditions.value,
    exhaustion: Math.max(0, Math.min(6, exhaustion.value)),
    concentration: null,
    deathSaves: { successes: 0, failures: 0 },
    stable: false,
    isPlayer: value["isPlayer"] === true,
    attacks: attacks.value,
    ...(rawCastingAbility !== undefined ? { spellcastingAbility: rawCastingAbility as Ability } : {}),
    ...(spellSlots.value !== undefined ? { spellSlots: spellSlots.value } : {}),
    ...(hitDice.value !== undefined ? { hitDice: hitDice.value } : {}),
    ...(value["reactionUsed"] === true ? { reactionUsed: true } : {}),
    ...(typeof value["attacksPerAction"] === "number"
      ? { attacksPerAction: Math.max(1, Math.trunc(value["attacksPerAction"])) }
      : {}),
    ...(typeof value["notes"] === "string" ? { notes: value["notes"] } : {}),
  });
}

/** Read and parse a single stat block file. */
export async function loadSheet(path: string): Promise<Result<Combatant, string>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    return err(`cannot read ${path}: ${(cause as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    return err(`${path} is not valid JSON: ${(cause as Error).message}`);
  }
  return parseCombatant(json, basename(path));
}

export interface SheetEntry {
  readonly id: string;
  readonly path: string;
}

/** List available stat blocks under a directory, keyed by filename stem. */
export async function listSheets(dir: string): Promise<Result<SheetEntry[], string>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return ok([]);
  }
  return ok(
    names
      // Loadouts sit beside party sheets but are not stat blocks.
      .filter((n) => extname(n) === ".json" && !n.endsWith(".loadout.json"))
      .map((n) => ({ id: basename(n, ".json"), path: join(dir, n) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

/** Find a stat block by name across several directories. */
export async function findSheet(
  ref: string,
  dirs: readonly string[],
): Promise<Result<Combatant, string>> {
  if (ref.endsWith(".json")) return loadSheet(ref);

  const tried: string[] = [];
  for (const dir of dirs) {
    const listing = await listSheets(dir);
    if (!listing.ok) return listing;
    const match = listing.value.find((e) => e.id.toLowerCase() === ref.toLowerCase());
    if (match) return loadSheet(match.path);
    tried.push(dir);
  }
  return err(`no stat block named "${ref}" in ${tried.join(", ")}`);
}
