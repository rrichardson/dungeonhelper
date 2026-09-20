/**
 * D&D Beyond character import.
 *
 * DDB does not serve a computed character sheet — it serves the ingredients its
 * own client uses to compute one. No final ability score, AC, HP maximum or
 * proficiency bonus appears in the payload; each has to be derived from base
 * values plus a pile of modifiers. This module does that derivation.
 *
 * Pure and total: no network, no clock, no filesystem. Input is the decoded
 * JSON; output is a Combatant plus a record of how every derived number was
 * reached, so the DM can check the import once against the real sheet instead
 * of trusting it silently.
 */

import { type Result, ok, err } from "../result.ts";
import {
  type Ability,
  type AppliedCondition,
  type Combatant,
  type ConditionName,
  type DamageType,
  ABILITIES,
  CONDITION_NAMES,
  DAMAGE_TYPES,
  abilityModifier,
} from "../types.ts";
import { type Json, arr, bool, isObject, num, obj, str, unwrapEnvelope } from "./ddb-shape.ts";
import { deriveAttacks } from "./ddb-attacks.ts";

// ─── DDB constants ──────────────────────────────────────────────────────────

const STAT_ID_TO_ABILITY: Readonly<Record<number, Ability>> = {
  1: "str",
  2: "dex",
  3: "con",
  4: "int",
  5: "wis",
  6: "cha",
};

const ABILITY_SCORE_SUBTYPE: Readonly<Record<string, Ability>> = {
  "strength-score": "str",
  "dexterity-score": "dex",
  "constitution-score": "con",
  "intelligence-score": "int",
  "wisdom-score": "wis",
  "charisma-score": "cha",
};

const SAVE_SUBTYPE: Readonly<Record<string, Ability>> = {
  "strength-saving-throws": "str",
  "dexterity-saving-throws": "dex",
  "constitution-saving-throws": "con",
  "intelligence-saving-throws": "int",
  "wisdom-saving-throws": "wis",
  "charisma-saving-throws": "cha",
};

/** DDB armorTypeId. 1-3 are body armor; 4 is a shield. */
const ARMOR_LIGHT = 1;
const ARMOR_MEDIUM = 2;
const ARMOR_HEAVY = 3;
const ARMOR_SHIELD = 4;

/** Maximum Dex bonus permitted by each body-armor category. */
const DEX_CAP: Readonly<Record<number, number>> = {
  [ARMOR_LIGHT]: Infinity,
  [ARMOR_MEDIUM]: 2,
  [ARMOR_HEAVY]: 0,
};

const DDB_CONDITION_IDS: Readonly<Record<number, ConditionName | "exhaustion">> = {
  1: "blinded",
  2: "charmed",
  3: "deafened",
  4: "exhaustion",
  5: "frightened",
  6: "grappled",
  7: "incapacitated",
  8: "invisible",
  9: "paralyzed",
  10: "petrified",
  11: "poisoned",
  12: "prone",
  13: "restrained",
  14: "stunned",
  15: "unconscious",
};

/** sourceId 145 is the 2024 Player's Handbook; 1 is the 2014 PHB. */
const SOURCE_PHB_2024 = 145;
const SOURCE_PHB_2014 = 1;

// ─── Result types ───────────────────────────────────────────────────────────

export type Ruleset = "2024" | "2014" | "unknown";

/** One modifier the importer considered, with the entity that granted it. */
export interface ModifierRef {
  readonly bucket: string;
  readonly type: string;
  readonly subType: string;
  readonly value: number | undefined;
  readonly source: string;
}

/** A derived number together with the arithmetic that produced it. */
export interface Derivation {
  readonly value: number;
  readonly explanation: string;
}

export interface DdbCharacterMeta {
  readonly ddbId: number | undefined;
  readonly ruleset: Ruleset;
  readonly classes: readonly { readonly name: string; readonly subclass?: string; readonly level: number }[];
  readonly totalLevel: number;
  readonly species: string | undefined;
  readonly background: string | undefined;
  readonly readonlyUrl: string | undefined;
  readonly importedFrom: "dndbeyond";
}

export interface DdbImport {
  readonly combatant: Combatant;
  readonly meta: DdbCharacterMeta;
  /** How each derived number was computed, for one-time verification. */
  readonly derivations: {
    readonly abilities: Readonly<Record<Ability, Derivation>>;
    readonly armorClass: Derivation;
    readonly maxHitPoints: Derivation;
    readonly speed: Derivation;
    readonly proficiencyBonus: Derivation;
  };
  /** Things the DM should check by eye. Never empty-by-default optimism. */
  readonly warnings: readonly string[];
}

// ─── Modifier collection ────────────────────────────────────────────────────

/**
 * Map D&D Beyond componentIds to the feature that granted them.
 *
 * Modifiers only carry a generic `friendlySubtypeName` ("Dexterity Score"),
 * which is useless for verification. The componentId matches the definition id
 * of the feat, species trait, class feature or background that granted it, so
 * a derivation can say "Moderately Armored +1" instead of "Dexterity Score +1".
 */
function componentNames(data: Json): Map<number, string> {
  const names = new Map<number, string>();

  const record = (entry: Json) => {
    const def = obj(entry, "definition");
    if (!def) return;
    const id = num(def, "id");
    const name = str(def, "name");
    if (id !== undefined && name !== undefined) names.set(id, name);
  };

  for (const f of arr(data, "feats")) record(f);

  const race = obj(data, "race");
  if (race) for (const t of arr(race, "racialTraits")) record(t);

  for (const c of arr(data, "classes")) {
    for (const f of arr(c, "classFeatures")) record(f);
    const def = obj(c, "definition");
    if (def) for (const f of arr(def, "classFeatures")) record(f);
  }

  const background = obj(data, "background");
  if (background) record(background);

  return names;
}

function modifierValue(m: Json): number | undefined {
  const fixed = num(m, "fixedValue");
  if (fixed !== undefined) return fixed;
  return num(m, "value");
}

/** Prefer the granting feature's name; fall back to the generic subtype label. */
function sourceName(m: Json, names: Map<number, string>, bucket: string): string {
  const componentId = num(m, "componentId");
  const named = componentId !== undefined ? names.get(componentId) : undefined;
  return named ?? str(m, "friendlySubtypeName") ?? `${bucket} modifier`;
}

/** True when a modifier carries a dice payload — a roll effect, not a flat bonus. */
function isDiceEffect(m: Json): boolean {
  return obj(m, "dice") !== undefined;
}

/**
 * Flatten the character's modifiers.
 *
 * The `item` bucket is deliberately skipped. It contains modifiers from every
 * item in the pack, equipped or not — a Potion of Healing's 4d4+4 appears there
 * as `bonus/hit-points`, and summing the bucket silently inflates the HP
 * maximum. Item modifiers are instead read from equipped inventory entries.
 */
function collectModifiers(data: Json): ModifierRef[] {
  const out: ModifierRef[] = [];
  const buckets = obj(data, "modifiers");
  if (!buckets) return out;
  const names = componentNames(data);

  for (const bucket of ["race", "class", "background", "feat", "condition"]) {
    const mods = Array.isArray(buckets[bucket]) ? (buckets[bucket] as Json[]) : [];
    for (const m of mods) {
      const type = str(m, "type");
      const subType = str(m, "subType");
      if (type === undefined || subType === undefined) continue;
      if (isDiceEffect(m)) continue;
      out.push({
        bucket,
        type,
        subType,
        value: modifierValue(m),
        source: sourceName(m, names, bucket),
      });
    }
  }
  return out;
}

interface EquippedItem {
  readonly name: string;
  readonly armorClass: number | undefined;
  readonly armorTypeId: number | undefined;
  readonly attuned: boolean;
  readonly requiresAttunement: boolean;
  readonly modifiers: readonly ModifierRef[];
}

/** Read equipped inventory, carrying each item's granted modifiers with it. */
function collectEquipped(data: Json): EquippedItem[] {
  const items: EquippedItem[] = [];
  for (const entry of arr(data, "inventory")) {
    if (bool(entry, "equipped") !== true) continue;
    const def = obj(entry, "definition");
    if (!def) continue;
    const name = str(def, "name") ?? "(unnamed item)";
    const attuned = bool(entry, "isAttuned") === true;
    const requiresAttunement = bool(def, "canAttune") === true;

    const mods: ModifierRef[] = [];
    const granted = Array.isArray(def["grantedModifiers"]) ? (def["grantedModifiers"] as Json[]) : [];
    for (const m of granted) {
      const type = str(m, "type");
      const subType = str(m, "subType");
      if (type === undefined || subType === undefined) continue;
      if (isDiceEffect(m)) continue;
      // An unattuned magic item that demands attunement grants nothing.
      if (str(m, "requiresAttunement") !== undefined && !attuned) continue;
      if (bool(m, "requiresAttunement") === true && !attuned) continue;
      mods.push({ bucket: "item", type, subType, value: modifierValue(m), source: name });
    }

    items.push({
      name,
      armorClass: num(def, "armorClass"),
      armorTypeId: num(def, "armorTypeId"),
      attuned,
      requiresAttunement,
      modifiers: mods,
    });
  }
  return items;
}

// ─── Derivations ────────────────────────────────────────────────────────────

function statMap(data: Json, key: string): Map<Ability, number | undefined> {
  const m = new Map<Ability, number | undefined>();
  for (const entry of arr(data, key)) {
    const id = num(entry, "id");
    if (id === undefined) continue;
    const ability = STAT_ID_TO_ABILITY[id];
    if (!ability) continue;
    m.set(ability, num(entry, "value"));
  }
  return m;
}

export function deriveAbilities(
  data: Json,
  mods: readonly ModifierRef[],
  warnings: string[],
): { scores: Record<Ability, number>; derivations: Record<Ability, Derivation> } {
  const base = statMap(data, "stats");
  const bonus = statMap(data, "bonusStats");
  const override = statMap(data, "overrideStats");

  const scores = {} as Record<Ability, number>;
  const derivations = {} as Record<Ability, Derivation>;

  for (const ability of ABILITIES) {
    const ov = override.get(ability);
    if (ov !== undefined && ov !== null) {
      scores[ability] = ov;
      derivations[ability] = { value: ov, explanation: `override on sheet = ${ov}` };
      continue;
    }

    const baseScore = base.get(ability);
    if (baseScore === undefined) {
      warnings.push(`no base ${ability.toUpperCase()} score found; defaulted to 10`);
      scores[ability] = 10;
      derivations[ability] = { value: 10, explanation: "missing from payload, defaulted to 10" };
      continue;
    }

    const parts: string[] = [`base ${baseScore}`];
    let total = baseScore;

    const b = bonus.get(ability);
    if (b !== undefined && b !== null && b !== 0) {
      total += b;
      parts.push(`sheet bonus ${b >= 0 ? "+" : ""}${b}`);
    }

    // `isGranted` is NOT an applicability gate: Moderately Armored's +1 Dex
    // carries isGranted=false and is unquestionably applied on the sheet.
    for (const mod of mods) {
      if (ABILITY_SCORE_SUBTYPE[mod.subType] !== ability) continue;
      if (mod.type !== "bonus") continue;
      const v = mod.value ?? 0;
      if (v === 0) continue;
      total += v;
      parts.push(`${mod.source} ${v >= 0 ? "+" : ""}${v}`);
    }

    // A `set` modifier (Belt of Giant Strength and friends) floors the score.
    for (const mod of mods) {
      if (ABILITY_SCORE_SUBTYPE[mod.subType] !== ability) continue;
      if (mod.type !== "set" && mod.type !== "set-base") continue;
      const v = mod.value;
      if (v === undefined) continue;
      if (v > total) {
        parts.push(`set to ${v} by ${mod.source}`);
        total = v;
      }
    }

    scores[ability] = total;
    derivations[ability] = { value: total, explanation: parts.join(" + ").replace(/\+ set/, "-> set") };
  }

  return { scores, derivations };
}

export function proficiencyBonusForLevel(level: number): number {
  if (level < 1) return 2;
  return 2 + Math.floor((Math.min(level, 20) - 1) / 4);
}

export function deriveArmorClass(
  dexMod: number,
  equipped: readonly EquippedItem[],
  mods: readonly ModifierRef[],
  warnings: string[],
): Derivation {
  const bodyArmor = equipped.filter(
    (i) =>
      i.armorClass !== undefined &&
      i.armorTypeId !== undefined &&
      i.armorTypeId >= ARMOR_LIGHT &&
      i.armorTypeId <= ARMOR_HEAVY,
  );
  const shields = equipped.filter((i) => i.armorTypeId === ARMOR_SHIELD && i.armorClass !== undefined);

  if (bodyArmor.length > 1) {
    warnings.push(
      `more than one body armor is equipped (${bodyArmor.map((a) => a.name).join(", ")}); used the highest base AC`,
    );
  }
  if (shields.length > 1) {
    warnings.push(`more than one shield is equipped (${shields.map((s) => s.name).join(", ")}); summed them`);
  }

  const parts: string[] = [];
  let total = 0;

  const worn = [...bodyArmor].sort((a, b) => (b.armorClass ?? 0) - (a.armorClass ?? 0))[0];
  if (worn) {
    const cap = DEX_CAP[worn.armorTypeId!] ?? Infinity;
    const applied = Math.min(dexMod, cap);
    total = (worn.armorClass ?? 0) + applied;
    parts.push(`${worn.name} ${worn.armorClass}`);
    if (cap === 0) {
      parts.push(`no Dex (heavy armor)`);
    } else if (applied < dexMod) {
      parts.push(`Dex +${applied} (capped from +${dexMod})`);
    } else {
      parts.push(`Dex ${applied >= 0 ? "+" : ""}${applied}`);
    }
  } else {
    total = 10 + dexMod;
    parts.push("unarmored 10", `Dex ${dexMod >= 0 ? "+" : ""}${dexMod}`);
    warnings.push(
      "no body armor equipped; used 10 + Dex. Unarmored Defense (Barbarian/Monk) and Draconic Resilience are not modeled — override the AC if the sheet disagrees.",
    );
  }

  for (const shield of shields) {
    total += shield.armorClass ?? 0;
    parts.push(`${shield.name} +${shield.armorClass}`);
  }

  const acMods = [...mods, ...equipped.flatMap((i) => i.modifiers)].filter(
    (m) => m.subType === "armor-class" && (m.type === "bonus" || m.type === "set"),
  );
  for (const m of acMods) {
    if (m.type === "set") {
      const v = m.value;
      if (v !== undefined && v > total) {
        parts.push(`set to ${v} by ${m.source}`);
        total = v;
      }
      continue;
    }
    const v = m.value ?? 0;
    if (v === 0) continue;
    total += v;
    parts.push(`${m.source} ${v >= 0 ? "+" : ""}${v}`);
  }

  return { value: total, explanation: parts.join(" + ") };
}

export function deriveMaxHitPoints(
  data: Json,
  conMod: number,
  totalLevel: number,
  mods: readonly ModifierRef[],
  equipped: readonly EquippedItem[],
  warnings: string[],
): Derivation {
  const override = num(data, "overrideHitPoints");
  if (override !== undefined) {
    return { value: override, explanation: `override on sheet = ${override}` };
  }

  const base = num(data, "baseHitPoints") ?? 0;
  const conTotal = conMod * totalLevel;
  const parts = [
    `class hit dice ${base}`,
    `Con ${conMod >= 0 ? "+" : ""}${conMod} x ${totalLevel} levels ${conTotal >= 0 ? "+" : ""}${conTotal}`,
  ];
  let total = base + conTotal;

  const sheetBonus = num(data, "bonusHitPoints");
  if (sheetBonus !== undefined && sheetBonus !== 0) {
    total += sheetBonus;
    parts.push(`sheet bonus ${sheetBonus >= 0 ? "+" : ""}${sheetBonus}`);
  }

  const hpMods = [...mods, ...equipped.flatMap((i) => i.modifiers)].filter(
    (m) => m.subType === "hit-points" && m.type === "bonus",
  );
  for (const m of hpMods) {
    const v = m.value ?? 0;
    if (v === 0) continue;
    total += v;
    parts.push(`${m.source} ${v >= 0 ? "+" : ""}${v}`);
    warnings.push(
      `applied a flat ${v >= 0 ? "+" : ""}${v} HP from "${m.source}". Per-level HP feats such as Tough are stored as a per-level value on D&D Beyond; verify this against the sheet.`,
    );
  }

  return { value: total, explanation: parts.join(" + ") };
}

export function deriveSpeed(data: Json, mods: readonly ModifierRef[]): Derivation {
  const race = obj(data, "race");
  const weight = race ? obj(race, "weightSpeeds") : undefined;
  const normal = weight ? obj(weight, "normal") : undefined;
  const walk = normal ? (num(normal, "walk") ?? 30) : 30;

  const parts = [`species walk ${walk}`];
  let total = walk;

  for (const m of mods) {
    if (m.subType !== "speed" && m.subType !== "innate-speed-walking") continue;
    const v = m.value ?? 0;
    if (v === 0) continue;
    if (m.type === "set" || m.type === "set-base") {
      if (v > total) {
        parts.push(`set to ${v} by ${m.source}`);
        total = v;
      }
      continue;
    }
    if (m.type !== "bonus") continue;
    total += v;
    parts.push(`${m.source} ${v >= 0 ? "+" : ""}${v}`);
  }

  return { value: total, explanation: parts.join(" + ") };
}

function detectRuleset(data: Json): Ruleset {
  const sourceIds: number[] = [];
  const race = obj(data, "race");
  if (race) {
    if (bool(race, "isLegacy") === true) return "2014";
    for (const s of arr(race, "sources")) {
      const id = num(s, "sourceId");
      if (id !== undefined) sourceIds.push(id);
    }
  }
  for (const c of arr(data, "classes")) {
    const def = obj(c, "definition");
    if (!def) continue;
    if (bool(def, "isLegacy") === true) return "2014";
    for (const s of arr(def, "sources")) {
      const id = num(s, "sourceId");
      if (id !== undefined) sourceIds.push(id);
    }
  }
  if (sourceIds.includes(SOURCE_PHB_2024)) return "2024";
  if (sourceIds.includes(SOURCE_PHB_2014)) return "2014";
  return "unknown";
}

function slugifyId(name: string, ddbId: number | undefined): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug !== "" ? slug : `ddb-${ddbId ?? "character"}`;
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Normalize a D&D Beyond payload into a Combatant.
 *
 * Accepts either the raw service envelope (`{ success, data }`) or the inner
 * character object.
 */
export function normalizeDdb(raw: Json): Result<DdbImport, string> {
  if (!isObject(raw)) return err("D&D Beyond payload is not an object");

  const envelope = obj(raw, "data");
  if (envelope === undefined && bool(raw, "success") === false) {
    return err(str(raw, "message") ?? "D&D Beyond reported failure");
  }
  const data = unwrapEnvelope(raw);
  if (!isObject(data)) return err("D&D Beyond payload has no character data");

  const name = str(data, "name");
  if (name === undefined || name.trim() === "") {
    return err("character has no name; payload is probably not a D&D Beyond character");
  }
  if (arr(data, "stats").length === 0) {
    return err(`character "${name}" has no ability scores; payload shape is unrecognized`);
  }

  const warnings: string[] = [];
  const mods = collectModifiers(data);
  const equipped = collectEquipped(data);

  const classes = arr(data, "classes").map((c) => {
    const def = obj(c, "definition");
    const sub = obj(c, "subclassDefinition");
    const className = (def ? str(def, "name") : undefined) ?? "(unknown class)";
    const subName = sub ? str(sub, "name") : undefined;
    return { name: className, subclass: subName, level: num(c, "level") ?? 0 };
  });
  const totalLevel = classes.reduce((n, c) => n + c.level, 0);
  if (totalLevel === 0) warnings.push("total class level is 0; proficiency bonus defaulted to +2");

  const { scores, derivations: abilityDerivations } = deriveAbilities(data, mods, warnings);
  const dexMod = abilityModifier(scores.dex);
  const conMod = abilityModifier(scores.con);

  const pb = proficiencyBonusForLevel(totalLevel);
  const armorClass = deriveArmorClass(dexMod, equipped, mods, warnings);
  const maxHp = deriveMaxHitPoints(data, conMod, totalLevel, mods, equipped, warnings);
  const speed = deriveSpeed(data, mods);

  const removed = num(data, "removedHitPoints") ?? 0;
  const temp = num(data, "temporaryHitPoints") ?? 0;
  const current = Math.max(0, maxHp.value - removed);

  const saveProficiencies = ABILITIES.filter((a) =>
    mods.some((m) => m.type === "proficiency" && SAVE_SUBTYPE[m.subType] === a),
  );

  const damageTypeSet = new Set<string>(DAMAGE_TYPES);
  const conditionNameSet = new Set<string>(CONDITION_NAMES);
  const allMods = [...mods, ...equipped.flatMap((i) => i.modifiers)];
  const byType = (t: string) =>
    [...new Set(allMods.filter((m) => m.type === t).map((m) => m.subType))];

  const resistances = byType("resistance").filter((s): s is DamageType => damageTypeSet.has(s));
  const immunitiesAll = byType("immunity");
  const immunities = immunitiesAll.filter((s): s is DamageType => damageTypeSet.has(s));
  const conditionImmunities = immunitiesAll.filter((s): s is ConditionName => conditionNameSet.has(s));
  const vulnerabilities = byType("vulnerability").filter((s): s is DamageType => damageTypeSet.has(s));

  const conditions: AppliedCondition[] = [];
  let exhaustion = 0;
  for (const c of arr(data, "conditions")) {
    const id = num(c, "id");
    if (id === undefined) continue;
    const mapped = DDB_CONDITION_IDS[id];
    if (mapped === undefined) {
      warnings.push(`unrecognized D&D Beyond condition id ${id} was skipped`);
      continue;
    }
    if (mapped === "exhaustion") {
      exhaustion = num(c, "level") ?? 1;
      continue;
    }
    conditions.push({ condition: mapped });
  }

  const ds = obj(data, "deathSaves");
  const deathSaves = {
    successes: (ds ? num(ds, "successCount") : undefined) ?? 0,
    failures: (ds ? num(ds, "failCount") : undefined) ?? 0,
  };
  const stable = (ds ? bool(ds, "isStabilized") : undefined) ?? false;

  const ruleset = detectRuleset(data);
  if (ruleset === "2014") {
    warnings.push(
      "this character was built on the 2014 ruleset, but the engine implements 2024 rules. Exhaustion, surprise and weapon mastery differ structurally — convert the sheet or run it knowingly.",
    );
  } else if (ruleset === "unknown") {
    warnings.push("could not determine whether this character is built on 2014 or 2024 rules");
  }

  const ddbId = num(data, "id");
  const race = obj(data, "race");
  const background = obj(data, "background");
  const backgroundDef = background ? obj(background, "definition") : undefined;

  const attacks = deriveAttacks(data, scores, pb, totalLevel, warnings);
  if (attacks.length === 0) {
    warnings.push("no attacks could be derived; add them by hand before running combat");
  }

  const combatant: Combatant = {
    id: slugifyId(name, ddbId),
    name,
    ac: armorClass.value,
    hp: { current, max: maxHp.value, temp },
    abilities: scores,
    proficiencyBonus: pb,
    saveProficiencies,
    speed: speed.value,
    resistances,
    immunities,
    vulnerabilities,
    conditionImmunities,
    conditions,
    exhaustion,
    concentration: null,
    deathSaves,
    stable,
    isPlayer: true,
    attacks,
  };

  const meta: DdbCharacterMeta = {
    ddbId,
    ruleset,
    classes,
    totalLevel,
    species: race ? (str(race, "fullName") ?? str(race, "baseRaceName")) : undefined,
    background: backgroundDef ? str(backgroundDef, "name") : undefined,
    readonlyUrl: str(data, "readonlyUrl"),
    importedFrom: "dndbeyond",
  };

  return ok({
    combatant,
    meta,
    derivations: {
      abilities: abilityDerivations,
      armorClass,
      maxHitPoints: maxHp,
      speed,
      proficiencyBonus: {
        value: pb,
        explanation: `level ${totalLevel} -> +${pb}`,
      },
    },
    warnings,
  });
}
