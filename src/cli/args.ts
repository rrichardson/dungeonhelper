/** Argument parsing helpers. Pure and total — every failure is a value. */

import { type Result, ok, err } from "../engine/result.ts";
import { DAMAGE_TYPES, CONDITION_NAMES, ABILITIES } from "../engine/types.ts";
import type { Ability, ConditionName, DamageType } from "../engine/types.ts";
import type { DamageSpec, Cover } from "../engine/attack.ts";

/** "1d8+4:slashing" → {expression, type}. The type suffix is required. */
export function parseDamageSpec(text: string): Result<DamageSpec, string> {
  const at = text.lastIndexOf(":");
  if (at === -1) {
    return err(`damage "${text}" needs a type, e.g. "1d8+4:slashing"`);
  }
  const expression = text.slice(0, at).trim();
  const type = text.slice(at + 1).trim().toLowerCase();
  if (expression === "") return err(`damage "${text}" has no dice expression`);
  if (!DAMAGE_TYPES.includes(type as DamageType)) {
    return err(`unknown damage type "${type}"; expected one of ${DAMAGE_TYPES.join(", ")}`);
  }
  return ok({ expression, type: type as DamageType });
}

export function parseDamageSpecs(values: readonly string[]): Result<DamageSpec[], string> {
  const out: DamageSpec[] = [];
  for (const v of values) {
    const parsed = parseDamageSpec(v);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return ok(out);
}

/** "12:fire" or "12" (defaulting to a supplied type) → a flat damage packet. */
export function parseFlatDamage(
  text: string,
  fallbackType: DamageType = "bludgeoning",
): Result<{ amount: number; type: DamageType }, string> {
  const at = text.lastIndexOf(":");
  const amountText = at === -1 ? text : text.slice(0, at);
  const typeText = at === -1 ? fallbackType : text.slice(at + 1).trim().toLowerCase();

  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount < 0) {
    return err(`"${amountText}" is not a non-negative number`);
  }
  if (!DAMAGE_TYPES.includes(typeText as DamageType)) {
    return err(`unknown damage type "${typeText}"; expected one of ${DAMAGE_TYPES.join(", ")}`);
  }
  return ok({ amount: Math.trunc(amount), type: typeText as DamageType });
}

export function parseAbility(text: string): Result<Ability, string> {
  const a = text.trim().toLowerCase();
  if (!ABILITIES.includes(a as Ability)) {
    return err(`unknown ability "${text}"; expected one of ${ABILITIES.join(", ")}`);
  }
  return ok(a as Ability);
}

export function parseCondition(text: string): Result<ConditionName, string> {
  const c = text.trim().toLowerCase();
  if (!CONDITION_NAMES.includes(c as ConditionName)) {
    return err(`unknown condition "${text}"; expected one of ${CONDITION_NAMES.join(", ")}`);
  }
  return ok(c as ConditionName);
}

export function parseCover(text: string | undefined): Result<Cover, string> {
  if (text === undefined) return ok("none");
  const c = text.trim().toLowerCase();
  const allowed: Cover[] = ["none", "half", "three-quarters", "total"];
  if (!allowed.includes(c as Cover)) {
    return err(`unknown cover "${text}"; expected one of ${allowed.join(", ")}`);
  }
  return ok(c as Cover);
}

export function parseInteger(text: string | undefined, label: string): Result<number, string> {
  if (text === undefined) return err(`missing ${label}`);
  const n = Number(text);
  if (!Number.isFinite(n)) return err(`${label} must be a number, got "${text}"`);
  return ok(Math.trunc(n));
}

/** "--dice 17,4,6" — physical dice the DM has already rolled, in order. */
export function parseSuppliedDice(text: string | undefined): Result<number[] | null, string> {
  if (text === undefined) return ok(null);
  const parts = text.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return err("--dice needs at least one value");
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1) return err(`--dice value "${p}" must be a positive integer`);
    out.push(n);
  }
  return ok(out);
}
