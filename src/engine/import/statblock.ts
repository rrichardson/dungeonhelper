/**
 * Parsing a Markdown stat block from a campaign wiki into a runnable creature.
 *
 * Wiki notes are written for human readers first, so two layouts are common
 * and both are accepted:
 *
 *   ## Armor Class          and      **Armor Class** 16 (natural armor)
 *   16 (natural armor)
 *
 * Pure and total. Anything unreadable becomes a warning, never a guess: a
 * stat block that half-parses silently is worse than one that says what it
 * could not read.
 */

import { type Result, ok, err } from "../result.ts";
import {
  ABILITIES, CONDITION_NAMES, DAMAGE_TYPES, abilityModifier,
  type Ability, type Combatant, type ConditionName, type DamageType, type WeaponAttack,
} from "../types.ts";
import { proficiencyForCr } from "./open5e.ts";

/** Pull a labelled field written either as a heading or as inline bold. */
export function field(markdown: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // **Armor Class** 16 (natural armor)
  const inline = new RegExp(`\\*\\*${escaped}:?\\*\\*:?[ \\t]*([^\\n]+)`, "i").exec(markdown);
  // ## Armor Class
  // 16 (natural armor)
  const heading = new RegExp(`^#{2,4}[ \\t]+${escaped}[ \\t]*$\\n+([^\\n]+)`, "im").exec(markdown);

  const candidates = [inline, heading].filter(
    (m): m is RegExpExecArray => m?.[1] !== undefined && m[1].trim() !== "",
  );
  if (candidates.length === 0) return undefined;

  // A note may carry a second, smaller stat block further down — a summoned
  // minion, say. The creature the note is about is the one written first, so
  // the earliest match wins rather than whichever layout was tried first.
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]![1]!.trim();
}

/** The leading integer of a field, e.g. "161 (17d10 + 68)" → 161. */
function leadingNumber(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  // Stat blocks write bonuses with an explicit sign: "+2".
  const m = /^\s*([+-]?\d+)/.exec(text.replace(/,/g, ""));
  return m ? Number(m[1]) : undefined;
}

/** Challenge ratings may be written as fractions. */
export function parseChallenge(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const fraction = /^\s*(\d+)\s*\/\s*(\d+)/.exec(text);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  return leadingNumber(text);
}

/** "30 ft., fly 50 ft." → 30 (the walking speed). */
export function parseSpeed(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const walk = /(?:^|\b)(?:walk\s+)?(\d+)\s*(?:ft|feet)/i.exec(text);
  return walk ? Number(walk[1]) : undefined;
}

/** "17d10 + 68" inside "161 (17d10 + 68)" → the pool. */
export function parseHitDicePool(text: string | undefined): { size: number; max: number } | null {
  if (text === undefined) return null;
  const m = /\((\d+)\s*d\s*(\d+)/i.exec(text);
  return m ? { max: Number(m[1]), size: Number(m[2]) } : null;
}

/**
 * Split a comma-separated list, dropping the parenthetical qualifiers wikis
 * use to narrow a defence ("poisoned (from Sporeblight sources)").
 */
function listItems(text: string | undefined): string[] {
  if (text === undefined) return [];
  return text
    .replace(/\([^)]*\)/g, "")
    .split(/[,;]|\band\b/i)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "" && part !== "—" && part !== "-" && part !== "none");
}

function typedList<T extends string>(
  text: string | undefined,
  allowed: readonly T[],
  warnings: string[],
  label: string,
): T[] {
  const out: T[] = [];
  for (const item of listItems(text)) {
    if ((allowed as readonly string[]).includes(item)) out.push(item as T);
    else warnings.push(`${label} "${item}" is not modelled by the engine and was dropped`);
  }
  return [...new Set(out)];
}

/** The six-column ability table wikis use for stat blocks. */
export function parseAbilityTable(
  markdown: string,
): Record<Ability, number> | null {
  const rows = markdown.split("\n").filter((line) => line.includes("|"));
  for (const row of rows) {
    const cells = row.split("|").map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length < 6) continue;

    const scores = cells.slice(0, 6).map((cell) => {
      const m = /^(\d+)\s*\(\s*[+-]?\d+\s*\)$/.exec(cell);
      return m ? Number(m[1]) : null;
    });
    if (scores.some((s) => s === null)) continue;

    const out = {} as Record<Ability, number>;
    ABILITIES.forEach((ability, i) => { out[ability] = scores[i]!; });
    return out;
  }
  return null;
}

/** "Str +10, Con +8" → the stated total bonus per ability. */
function parseSaveBonuses(text: string | undefined): Partial<Record<Ability, number>> {
  const out: Partial<Record<Ability, number>> = {};
  if (text === undefined) return out;
  const names: Record<string, Ability> = {
    str: "str", strength: "str", dex: "dex", dexterity: "dex",
    con: "con", constitution: "con", int: "int", intelligence: "int",
    wis: "wis", wisdom: "wis", cha: "cha", charisma: "cha",
  };
  for (const m of text.matchAll(/([A-Za-z]+)\s*([+-]\d+)/g)) {
    const ability = names[m[1]!.toLowerCase()];
    if (ability) out[ability] = Number(m[2]);
  }
  return out;
}

const ATTACK_LINE =
  /\*\*(?<name>[^*]+?)\.?\*\*\s*\*(?<kind>Melee|Ranged)[^*]*Attack:?\*:?\s*(?<bonus>[+-]\d+)\s*to hit(?<middle>[^*]*)\*Hit:?\*:?\s*(?<damage>[^\n]+)/gi;

/** Extract every "+N to hit … Hit: X (NdM + K) type damage" line. */
export function parseAttacks(markdown: string, warnings: string[]): WeaponAttack[] {
  const out: WeaponAttack[] = [];

  for (const match of markdown.matchAll(ATTACK_LINE)) {
    const groups = match.groups;
    if (!groups) continue;

    const name = groups["name"]!.trim();
    const melee = groups["kind"]!.toLowerCase() === "melee";
    const bonus = Number(groups["bonus"]);
    const middle = groups["middle"] ?? "";
    const damageText = groups["damage"]!;

    // Only the first sentence is the damage of a single hit. What follows is
    // a rider — bleed on a crit, damage while swallowed — which depends on
    // circumstances the engine cannot see, so folding it in would inflate
    // every hit.
    const sentenceEnd = damageText.search(/\.\s/);
    const firstSentence = sentenceEnd === -1 ? damageText : damageText.slice(0, sentenceEnd);
    const remainder = sentenceEnd === -1 ? "" : damageText.slice(sentenceEnd);
    if (/\d+d\d+/.test(remainder)) {
      warnings.push(
        `"${name}" states conditional extra damage that is not applied automatically: ${remainder.trim()}`,
      );
    }

    // "24 (2d10 + 6) slashing damage plus 13 (2d8) poison damage"
    const damage: { expression: string; type: DamageType }[] = [];
    for (const d of firstSentence.matchAll(
      /\d+\s*\(\s*(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*\)\s*(\w+)\s+damage/gi,
    )) {
      const typeName = d[2]!.toLowerCase();
      if (!(DAMAGE_TYPES as readonly string[]).includes(typeName)) {
        warnings.push(`"${name}" deals "${typeName}" damage, which the engine does not model`);
        continue;
      }
      damage.push({
        expression: d[1]!.replace(/\s+/g, ""),
        type: typeName as DamageType,
      });
    }

    if (damage.length === 0) {
      warnings.push(`"${name}" has no readable damage expression and was skipped`);
      continue;
    }

    const reach = /reach\s+(\d+)\s*(?:ft|feet)/i.exec(middle);
    const range = /range\s+(\d+)\s*\/\s*(\d+)\s*(?:ft|feet)/i.exec(middle)
      ?? /range\s+(\d+)\s*(?:ft|feet)/i.exec(middle);

    // Riders such as "and the target is grappled" are narrative, not damage.
    if (/\b(?:and|or|saving throw)\b/i.test(firstSentence.replace(/plus[^,]*/gi, ""))) {
      warnings.push(`"${name}" has an effect beyond damage — apply it yourself: ${firstSentence.trim()}`);
    }

    out.push({
      name: name.toLowerCase(),
      bonus,
      damage,
      melee,
      ...(melee
        ? { range: reach ? Number(reach[1]) : 5 }
        : range
          ? { range: Number(range[1]), ...(range[2] ? { longRange: Number(range[2]) } : {}) }
          : {}),
    });
  }

  return out;
}

function slugify(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "creature" : cleaned;
}

export interface StatBlockImport {
  readonly combatant: Combatant;
  readonly challengeRating: number | undefined;
  readonly warnings: readonly string[];
}

/** Parse a wiki note into a runnable creature. */
export function parseStatBlock(markdown: string, fallbackName?: string): Result<StatBlockImport, string> {
  const titleMatch = /^#\s+(.+)$/m.exec(markdown);
  const name = (titleMatch?.[1] ?? fallbackName ?? "").trim();
  if (name === "") return err("note has no title and no name was supplied");

  const warnings: string[] = [];

  const abilities = parseAbilityTable(markdown);
  if (abilities === null) {
    return err(`"${name}" has no readable ability score table — the engine needs one to run it`);
  }

  const acText = field(markdown, "Armor Class");
  const hpText = field(markdown, "Hit Points");
  const ac = leadingNumber(acText);
  const hp = leadingNumber(hpText);
  if (ac === undefined) return err(`"${name}" has no readable Armor Class`);
  if (hp === undefined) return err(`"${name}" has no readable Hit Points`);

  const cr = parseChallenge(field(markdown, "Challenge"));
  const statedPb = leadingNumber(field(markdown, "Proficiency Bonus"));
  const proficiencyBonus = statedPb ?? (cr !== undefined ? proficiencyForCr(cr) : 2);
  if (statedPb === undefined && cr === undefined) {
    warnings.push("no Challenge or Proficiency Bonus stated; proficiency defaulted to +2");
  }

  const speed = parseSpeed(field(markdown, "Speed")) ?? 30;

  const saves = parseSaveBonuses(field(markdown, "Saving Throws"));
  const saveProficiencies = ABILITIES.filter((ability) => {
    const stated = saves[ability];
    return stated !== undefined && stated > abilityModifier(abilities[ability]);
  });

  const resistances = typedList<DamageType>(field(markdown, "Damage Resistances"), DAMAGE_TYPES, warnings, "resistance");
  const immunities = typedList<DamageType>(field(markdown, "Damage Immunities"), DAMAGE_TYPES, warnings, "immunity");
  const vulnerabilities = typedList<DamageType>(field(markdown, "Damage Vulnerabilities"), DAMAGE_TYPES, warnings, "vulnerability");
  const conditionImmunities = typedList<ConditionName>(field(markdown, "Condition Immunities"), CONDITION_NAMES, warnings, "condition immunity");

  const attacks = parseAttacks(markdown, warnings);
  if (attacks.length === 0) {
    warnings.push("no attacks could be read; add them by hand before running combat");
  }

  // Traits, legendary and lair actions are narrative text the engine cannot
  // apply. Naming them is more useful than silently dropping them.
  for (const section of ["Traits", "Legendary Actions", "Lair Actions", "Reactions", "Bonus Actions"]) {
    if (new RegExp(`^#{2,4}\\s+${section}\\s*$`, "im").test(markdown)) {
      warnings.push(`"${section}" are not modelled — read them from the note and apply them yourself`);
    }
  }

  const hitDice = parseHitDicePool(hpText);

  return ok({
    combatant: {
      id: slugify(name),
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
      notes: cr !== undefined ? `CR ${cr} · imported from the campaign wiki` : "imported from the campaign wiki",
    },
    challengeRating: cr,
    warnings,
  });
}
