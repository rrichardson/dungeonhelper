/**
 * Deriving attacks from a D&D Beyond payload.
 *
 * Two sources, with different availability rules:
 *
 *  - Weapons carried in inventory. Ability is Strength, or Dexterity where
 *    finesse or a ranged weapon allows it; proficiency is added only when the
 *    character actually has it.
 *
 *  - Spells that require an attack roll. Availability cannot be read from
 *    `prepared`: known-casters (warlocks, sorcerers, bards) leave it false on
 *    every spell they own, so filtering on it would silently drop a warlock's
 *    entire offence. A spell counts as available when it is known, prepared or
 *    always prepared; cantrips are at-will and need no slot at all.
 *
 * Pure. Anything it cannot determine becomes a warning, never a guess.
 */

import {
  type Json, isObject, obj, arr, num, str, bool,
} from "./ddb-shape.ts";
import { abilityModifier, DAMAGE_TYPES, type Ability, type DamageType, type WeaponAttack } from "../types.ts";

/** DDB attackType: 1 is a melee attack, 2 is ranged. */
const ATTACK_MELEE = 1;

/** DDB weapon categoryId. */
const CATEGORY_SIMPLE = 1;
const CATEGORY_MARTIAL = 2;

/** DDB stat ids, shared with the main normalizer. */
const SPELL_ABILITY: Readonly<Record<number, Ability>> = {
  1: "str", 2: "dex", 3: "con", 4: "int", 5: "wis", 6: "cha",
};

/**
 * Cantrips whose scaling is not "multiply the damage dice".
 *
 * Eldritch Blast adds beams, each its own attack roll. Toll the Dead switches
 * die size by target state. The blade cantrips scale a rider on a weapon
 * attack. Each is reported rather than scaled, so nobody gets a confidently
 * wrong number.
 */
const IRREGULAR_CANTRIPS = new Set([
  "eldritch blast",
  "toll the dead",
  "booming blade",
  "green-flame blade",
]);

/**
 * Cantrip damage steps up at levels 5, 11 and 17 in both rulesets. The tier is
 * how many dice (or, for Eldritch Blast, how many beams) the cantrip produces.
 */
export function cantripTier(characterLevel: number): number {
  if (characterLevel >= 17) return 4;
  if (characterLevel >= 11) return 3;
  if (characterLevel >= 5) return 2;
  return 1;
}

function damageType(raw: string | undefined): DamageType | undefined {
  if (raw === undefined) return undefined;
  const lowered = raw.trim().toLowerCase();
  return (DAMAGE_TYPES as readonly string[]).includes(lowered)
    ? (lowered as DamageType)
    : undefined;
}

/** Render a signed modifier onto a dice expression: "1d8" + 3 -> "1d8+3". */
function withModifier(dice: string, modifier: number): string {
  if (modifier === 0) return dice;
  return `${dice}${modifier > 0 ? "+" : "-"}${Math.abs(modifier)}`;
}

function propertyNames(definition: Json): string[] {
  return arr(definition, "properties")
    .map((p) => str(p, "name"))
    .filter((n): n is string => n !== undefined)
    .map((n) => n.toLowerCase());
}

/** All proficiency subtypes the character has, e.g. "simple-weapons". */
export function proficiencySubtypes(data: Json): Set<string> {
  const out = new Set<string>();
  const buckets = obj(data, "modifiers");
  if (!buckets) return out;
  for (const key of Object.keys(buckets)) {
    for (const m of arr(buckets, key)) {
      if (str(m, "type") === "proficiency") {
        const sub = str(m, "subType");
        if (sub !== undefined) out.add(sub);
      }
    }
  }
  return out;
}

function weaponProficient(definition: Json, proficiencies: ReadonlySet<string>): boolean {
  const category = num(definition, "categoryId");
  if (category === CATEGORY_SIMPLE && proficiencies.has("simple-weapons")) return true;
  if (category === CATEGORY_MARTIAL && proficiencies.has("martial-weapons")) return true;

  // Individual weapon proficiencies appear as the weapon's own slug.
  const type = str(definition, "type");
  if (type !== undefined && proficiencies.has(type.toLowerCase().replace(/\s+/g, "-"))) {
    return true;
  }
  return false;
}

/** A magic weapon's flat bonus, when the payload states one. */
function magicBonus(definition: Json, warnings: string[], name: string): number {
  let bonus = 0;
  let sawDice = false;
  for (const m of arr(definition, "grantedModifiers")) {
    const type = str(m, "type");
    const sub = str(m, "subType");
    if (type !== "bonus") continue;
    if (obj(m, "die") !== undefined) sawDice = true;
    if (sub === "magic" || sub === "weapon-attacks" || sub === "weapon-damage") {
      bonus = Math.max(bonus, num(m, "value") ?? 0);
    }
  }
  if (bonus === 0 && bool(definition, "magic") === true) {
    warnings.push(`"${name}" is magical but states no flat bonus; attack and damage use the mundane numbers`);
  }
  if (sawDice) {
    warnings.push(`"${name}" grants extra damage dice that were not added automatically — check the sheet`);
  }
  return bonus;
}

export interface WeaponContext {
  readonly scores: Readonly<Record<Ability, number>>;
  readonly proficiencyBonus: number;
  readonly proficiencies: ReadonlySet<string>;
}

/** Attacks from every weapon in inventory, equipped or merely carried. */
export function weaponAttacks(
  data: Json,
  ctx: WeaponContext,
  warnings: string[],
): WeaponAttack[] {
  const out: WeaponAttack[] = [];
  const strMod = abilityModifier(ctx.scores.str);
  const dexMod = abilityModifier(ctx.scores.dex);

  for (const item of arr(data, "inventory")) {
    const definition = obj(item, "definition");
    if (!definition) continue;
    if (str(definition, "filterType") !== "Weapon") continue;

    const name = str(definition, "name") ?? "(unnamed weapon)";
    const attackType = num(definition, "attackType") ?? ATTACK_MELEE;
    const melee = attackType === ATTACK_MELEE;
    const properties = propertyNames(definition);

    // Finesse lets either ability apply; a ranged weapon uses Dexterity.
    const finesse = properties.includes("finesse");
    const abilityMod = melee
      ? finesse ? Math.max(strMod, dexMod) : strMod
      : finesse ? Math.max(strMod, dexMod) : dexMod;

    const proficient = weaponProficient(definition, ctx.proficiencies);
    if (!proficient) {
      warnings.push(`not proficient with "${name}" — attack bonus excludes the proficiency bonus`);
    }

    const magic = magicBonus(definition, warnings, name);
    const bonus = abilityMod + (proficient ? ctx.proficiencyBonus : 0) + magic;

    const dice = str(obj(definition, "damage"), "diceString");
    const type = damageType(str(definition, "damageType"));
    if (dice === undefined || type === undefined) {
      warnings.push(`"${name}" has no readable damage; skipped`);
      continue;
    }

    const equipped = bool(item, "equipped") === true;
    const note = [
      equipped ? "equipped" : "carried",
      ...(properties.length > 0 ? [properties.join(", ")] : []),
    ].join(" · ");

    out.push({
      name: name.toLowerCase(),
      bonus,
      damage: [{ expression: withModifier(dice, abilityMod + magic), type }],
      melee,
      note,
    });

    // Versatile weapons get a second entry for the two-handed die.
    const versatile = arr(definition, "properties").find(
      (p) => (str(p, "name") ?? "").toLowerCase() === "versatile",
    );
    if (versatile) {
      const notes = str(versatile, "notes");
      const twoHanded = notes?.match(/\d+d\d+/)?.[0];
      if (twoHanded) {
        out.push({
          name: `${name.toLowerCase()} (two-handed)`,
          bonus,
          damage: [{ expression: withModifier(twoHanded, abilityMod + magic), type }],
          melee,
          note: `${note} · versatile`,
        });
      } else {
        warnings.push(`"${name}" is versatile but states no two-handed die; only the one-handed attack was imported`);
      }
    }
  }

  return dedupeAttacks(out);
}

/**
 * Carrying two identical daggers should not produce two identical attacks —
 * the CLI selects attacks by name, so duplicates would be ambiguous.
 */
function dedupeAttacks(attacks: readonly WeaponAttack[]): WeaponAttack[] {
  const byKey = new Map<string, { attack: WeaponAttack; count: number }>();
  for (const attack of attacks) {
    const key = [
      attack.name,
      attack.bonus,
      attack.melee,
      attack.damage.map((d) => `${d.expression}:${d.type}`).join("|"),
    ].join("/");
    const seen = byKey.get(key);
    if (seen) seen.count += 1;
    else byKey.set(key, { attack, count: 1 });
  }
  return [...byKey.values()].map(({ attack, count }) =>
    count === 1 ? attack : { ...attack, note: `${attack.note ?? ""} · x${count}`.replace(/^ · /, "") },
  );
}

interface SpellEntry {
  readonly definition: Json;
  readonly available: boolean;
  readonly reason: string;
}

/**
 * Every spell the character owns, with whether it can actually be cast.
 * Known-casters leave `prepared` false on everything, so it is never the sole
 * test for availability.
 */
function collectSpells(data: Json): SpellEntry[] {
  const out: SpellEntry[] = [];

  const consider = (entry: Json): void => {
    const definition = obj(entry, "definition");
    if (!definition) return;

    const level = num(definition, "level") ?? 0;
    const known = bool(entry, "countsAsKnownSpell") === true;
    const prepared = bool(entry, "prepared") === true;
    const always = bool(entry, "alwaysPrepared") === true;
    const usesSlot = bool(entry, "usesSpellSlot");

    // A cantrip is at-will: no slot, no preparation.
    if (level === 0 || usesSlot === false) {
      out.push({ definition, available: true, reason: "at-will cantrip" });
      return;
    }
    if (known) { out.push({ definition, available: true, reason: "known" }); return; }
    if (always) { out.push({ definition, available: true, reason: "always prepared" }); return; }
    if (prepared) { out.push({ definition, available: true, reason: "prepared" }); return; }
    out.push({ definition, available: false, reason: "not prepared" });
  };

  for (const bucket of arr(data, "classSpells")) {
    for (const entry of arr(bucket, "spells")) consider(entry);
  }
  const spells = obj(data, "spells");
  if (spells) {
    for (const key of Object.keys(spells)) {
      for (const entry of arr(spells, key)) consider(entry);
    }
  }
  return out;
}

/** The spellcasting ability of the first class that casts. */
export function spellcastingAbility(data: Json): Ability | undefined {
  for (const c of arr(data, "classes")) {
    const definition = obj(c, "definition");
    const id = definition ? num(definition, "spellCastingAbilityId") : undefined;
    if (id !== undefined && SPELL_ABILITY[id]) return SPELL_ABILITY[id];
  }
  return undefined;
}

/**
 * Invocations that add the spellcasting modifier to a cantrip's damage.
 *
 * D&D Beyond names these with their target spell in parentheses — "Agonizing
 * Blast (Eldritch Blast)" — so the affected spell is read from the option
 * rather than hard-coded. Without this, a warlock's main attack imports for
 * several points less damage than it actually deals.
 */
export function damageRiders(data: Json): Set<string> {
  const out = new Set<string>();
  const options = obj(data, "options");
  if (!options) return out;

  for (const key of Object.keys(options)) {
    for (const option of arr(options, key)) {
      const definition = obj(option, "definition");
      const name = definition ? str(definition, "name") : undefined;
      if (name === undefined) continue;
      const match = /^agonizing blast\s*\(([^)]+)\)/i.exec(name.trim());
      if (match) out.add(match[1]!.trim().toLowerCase());
    }
  }
  return out;
}

export interface SpellContext {
  readonly scores: Readonly<Record<Ability, number>>;
  readonly proficiencyBonus: number;
  readonly totalLevel: number;
  readonly ability: Ability | undefined;
}

/** Attacks from spells that require an attack roll. */
export function spellAttacks(
  data: Json,
  ctx: SpellContext,
  warnings: string[],
): WeaponAttack[] {
  const entries = collectSpells(data).filter(
    (e) => bool(e.definition, "requiresAttackRoll") === true,
  );
  if (entries.length === 0) return [];

  if (ctx.ability === undefined) {
    warnings.push("character has attack spells but no detectable spellcasting ability; spell attacks were skipped");
    return [];
  }

  const abilityMod = abilityModifier(ctx.scores[ctx.ability]);
  const bonus = abilityMod + ctx.proficiencyBonus;
  const tier = cantripTier(ctx.totalLevel);
  const riders = damageRiders(data);
  const out: WeaponAttack[] = [];

  for (const entry of entries) {
    const name = str(entry.definition, "name") ?? "(unnamed spell)";
    if (!entry.available) {
      warnings.push(`attack spell "${name}" is ${entry.reason} and was not imported`);
      continue;
    }

    const level = num(entry.definition, "level") ?? 0;
    const melee = (num(entry.definition, "attackType") ?? 2) === ATTACK_MELEE;

    const damage = arr(entry.definition, "modifiers")
      .filter((m) => str(m, "type") === "damage")
      .map((m) => ({
        dice: str(obj(m, "die"), "diceString"),
        type: damageType(str(m, "subType")),
      }))
      .filter((d): d is { dice: string; type: DamageType } =>
        d.dice !== undefined && d.type !== undefined);

    if (damage.length === 0) {
      warnings.push(`attack spell "${name}" has no readable damage; skipped`);
      continue;
    }

    // Only the first damage entry is the damage of a single hit. Later entries
    // are sustained or upcast damage (Witch Bolt's 1d12 on following turns),
    // and adding them would silently inflate every hit.
    const primary = damage[0]!;
    if (damage.length > 1) {
      const rest = damage.slice(1).map((d) => `${d.dice} ${d.type}`).join(", ");
      warnings.push(
        `"${name}" lists further damage (${rest}) beyond its initial hit — sustained or upcast damage is not applied automatically`,
      );
    }

    // Cantrip damage scales with character level. Eldritch Blast scales by
    // adding beams — each its own attack roll — rather than by adding dice,
    // so it cannot be folded into one entry.
    const notes: string[] = [entry.reason];
    let scaled = primary.dice;

    if (level === 0 && tier > 1) {
      const lowered = name.toLowerCase();
      if (lowered === "eldritch blast") {
        notes.push(`${tier} beams at level ${ctx.totalLevel} — roll this attack once per beam`);
      } else if (IRREGULAR_CANTRIPS.has(lowered)) {
        warnings.push(
          `"${name}" scales in a way this importer does not model; its damage is the level 1 value — set it by hand`,
        );
        notes.push(`cantrip tier ${tier}: scaling not applied`);
      } else {
        // The general rule: a damage cantrip adds a die at 5th, 11th and 17th.
        const match = /^(\d*)d(\d+)$/.exec(primary.dice);
        if (match) {
          const count = (match[1] === "" ? 1 : Number(match[1])) * tier;
          scaled = `${count}d${match[2]}`;
          notes.push(`cantrip tier ${tier} at level ${ctx.totalLevel}`);
        } else {
          warnings.push(
            `"${name}" has damage "${primary.dice}" that could not be scaled for tier ${tier} — verify by hand`,
          );
        }
      }
    }
    if (level > 0) notes.push(`level ${level} slot`);

    // An invocation such as Agonizing Blast adds the spellcasting modifier to
    // each hit of its cantrip.
    const rider = riders.has(name.toLowerCase()) ? abilityMod : 0;
    if (rider !== 0) notes.push(`+${rider} from Agonizing Blast`);

    out.push({
      name: name.toLowerCase(),
      bonus,
      damage: [{ expression: withModifier(scaled, rider), type: primary.type }],
      melee,
      note: notes.join(" · "),
    });
  }

  return out;
}

/** Weapons and spell attacks together. */
export function deriveAttacks(
  data: Json,
  scores: Readonly<Record<Ability, number>>,
  proficiencyBonus: number,
  totalLevel: number,
  warnings: string[],
): WeaponAttack[] {
  const proficiencies = proficiencySubtypes(data);
  const weapons = weaponAttacks(data, { scores, proficiencyBonus, proficiencies }, warnings);
  const spells = spellAttacks(
    data,
    { scores, proficiencyBonus, totalLevel, ability: spellcastingAbility(data) },
    warnings,
  );
  return [...weapons, ...spells];
}
