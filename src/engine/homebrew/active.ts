/**
 * Which homebrew applies, and the numbers it contributes.
 *
 * Pure. This module never rolls except where a rest regains dice-based
 * charges, and then only through an injected Rng.
 */

import type { Rng } from "../rng.ts";
import { type Result, ok, err } from "../result.ts";
import { roll } from "../dice.ts";
import type { Ability, Combatant, DamageType } from "../types.ts";
import { contextOf, evalFormula } from "./formula.ts";
import { slugify } from "./schema.ts";
import type {
  Attached, Condition, Effect, Expiry, Grant, Hook, RestPeriod, ResourcePool, Timed, Until,
} from "./types.ts";

// ── What is live ──────────────────────────────────────────────────────────

/** An item that needs attunement does nothing until it is attuned. */
export function isActive(a: Attached): boolean {
  return !a.def.attunement || a.attuned;
}

export function activeDefs(c: Combatant): readonly Attached[] {
  return (c.homebrew ?? []).filter(isActive);
}

/** The attack name a weapon definition answers to, or null for non-weapons. */
export function weaponNameOf(a: Attached): string | null {
  if (a.def.kind !== "weapon") return null;
  return a.def.grantsAttack?.name ?? a.def.name;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The creature's own tags plus those its homebrew grants. */
export function creatureTags(c: Combatant): readonly string[] {
  const out = new Set((c.tags ?? []).map((t) => t.toLowerCase()));
  for (const a of activeDefs(c)) for (const t of a.def.creatureTags) out.add(t);
  return [...out];
}

/** Source tags an attack carries: those the DM passed plus the weapon's own. */
export function attackTags(c: Combatant, weapon: string | undefined, passed: readonly string[]): readonly string[] {
  const out = new Set(passed.map((t) => t.toLowerCase()));
  if (weapon !== undefined) {
    for (const a of activeDefs(c)) {
      const name = weaponNameOf(a);
      if (name !== null && sameName(name, weapon)) for (const t of a.def.attackTags) out.add(t);
    }
  }
  return [...out];
}

export interface MatchContext {
  readonly tags?: readonly string[];
  readonly targetTags?: readonly string[];
  readonly weapon?: string;
  /** Damage types in play; a condition on type holds if any matches. */
  readonly types?: readonly DamageType[];
}

export function holds(cond: Condition, ctx: MatchContext): boolean {
  if (cond.tag && !cond.tag.some((t) => (ctx.tags ?? []).includes(t))) return false;
  if (cond.targetTag && !cond.targetTag.some((t) => (ctx.targetTags ?? []).includes(t))) return false;
  if (cond.type && !cond.type.some((t) => (ctx.types ?? []).includes(t))) return false;
  if (cond.weapon && (ctx.weapon === undefined || !cond.weapon.some((w) => sameName(w, ctx.weapon!)))) return false;
  return true;
}

/** Hooks a weapon only fires for when the attack is made with it. */
const WEAPON_SCOPED: readonly Hook[] = ["outgoing-damage", "critical-hit", "reduces-target-to-0"];

export interface LiveEffect {
  readonly attached: Attached;
  readonly effect: Effect;
  /** "<def name>: <effect name>", used in every log line. */
  readonly label: string;
  /** Key of this effect's uses pool, when it has one. */
  readonly resource: string | null;
}

export function resourceKey(defId: string, name: string): string {
  return `${defId}/${slugify(name)}`;
}

function labelOf(a: Attached, e: Effect): string {
  return e.name === a.def.name || e.name.startsWith(`${a.def.name} #`) ? a.def.name : `${a.def.name}: ${e.name}`;
}

/**
 * Effects on a creature for one hook whose conditions hold. Type conditions
 * are left to the caller when `ctx.types` is omitted, because damage checks
 * them per packet.
 */
export function effectsFor(c: Combatant, hook: Hook, ctx: MatchContext): LiveEffect[] {
  const out: LiveEffect[] = [];
  for (const a of activeDefs(c)) {
    const weaponName = weaponNameOf(a);
    if (weaponName !== null && WEAPON_SCOPED.includes(hook)) {
      if (ctx.weapon === undefined || !sameName(weaponName, ctx.weapon)) continue;
    }
    for (const e of a.def.effects) {
      if (e.hook !== hook) continue;
      const typeFree = ctx.types === undefined;
      const when = e.when && typeFree ? { ...e.when, type: undefined } : e.when;
      if (when && !holds(when, ctx)) continue;
      // An "unless" that names a type can only be judged per damage packet.
      const deferUnless = typeFree && e.unless?.type !== undefined;
      if (e.unless && !deferUnless && hasAny(e.unless) && holds(e.unless, ctx)) continue;
      out.push({
        attached: a,
        effect: e,
        label: labelOf(a, e),
        resource: e.uses ? resourceKey(a.def.id, e.name) : null,
      });
    }
  }
  return out;
}

/** Whether an effect found by effectsFor applies to one damage packet of this type. */
export function appliesToType(e: Effect, ctx: MatchContext, type: DamageType): boolean {
  const withType = { ...ctx, types: [type] };
  if (e.when && !holds(e.when, withType)) return false;
  if (e.unless && hasAny(e.unless) && holds(e.unless, withType)) return false;
  return true;
}

function hasAny(c: Condition): boolean {
  return Boolean(c.tag || c.targetTag || c.type || c.weapon);
}

// ── Static totals ─────────────────────────────────────────────────────────

export interface Part {
  readonly label: string;
  readonly value: number;
}

interface LabelledGrant {
  readonly label: string;
  readonly grant: Grant;
}

/**
 * Every static grant in force: on: always effects (weapon-only numbers count
 * only for that weapon) and timed grants from triggers.
 */
export function grantsOf(c: Combatant, weapon?: string): LabelledGrant[] {
  const out: LabelledGrant[] = [];
  for (const a of activeDefs(c)) {
    const weaponName = weaponNameOf(a);
    for (const e of a.def.effects) {
      if (e.hook !== "always") continue;
      if (e.when && !holds({ ...e.when, type: undefined }, { weapon })) continue;
      for (const act of e.actions) {
        if (act.kind !== "grant") continue;
        let g = act.grant;
        // A weapon's attack numbers belong to attacks made with it.
        if (weaponName !== null && (weapon === undefined || !sameName(weaponName, weapon))) {
          g = { ...g, attackBonus: undefined, damageBonus: undefined, critRange: undefined };
        }
        out.push({ label: labelOf(a, e), grant: g });
      }
    }
  }
  for (const t of c.timed ?? []) if (t.grant) out.push({ label: t.label, grant: t.grant });
  return out;
}

function sumParts(grants: readonly LabelledGrant[], pick: (g: Grant) => number | undefined): { total: number; parts: Part[] } {
  const parts: Part[] = [];
  for (const { label, grant } of grants) {
    const v = pick(grant);
    if (v !== undefined && v !== 0) parts.push({ label, value: v });
  }
  return { total: parts.reduce((s, p) => s + p.value, 0), parts };
}

export const acBonus = (c: Combatant) => sumParts(grantsOf(c), (g) => g.ac);
export const speedBonus = (c: Combatant) => sumParts(grantsOf(c), (g) => g.speed);
export const attackBonusFor = (c: Combatant, weapon: string) => sumParts(grantsOf(c, weapon), (g) => g.attackBonus);
export const damageBonusFor = (c: Combatant, weapon: string) => sumParts(grantsOf(c, weapon), (g) => g.damageBonus);

export function saveBonus(c: Combatant, ability: Ability) {
  return sumParts(grantsOf(c), (g) => (g.saveBonus?.[ability] ?? 0) + (g.saveBonus?.all ?? 0) || undefined);
}

export function checkBonus(c: Combatant, ability: Ability) {
  return sumParts(grantsOf(c), (g) => (g.checkBonus?.[ability] ?? 0) + (g.checkBonus?.all ?? 0) || undefined);
}

/** The lowest crit range granted for this weapon, or null if none is. */
export function critRangeFor(c: Combatant, weapon: string): Part | null {
  let best: Part | null = null;
  for (const { label, grant } of grantsOf(c, weapon)) {
    if (grant.critRange !== undefined && (best === null || grant.critRange < best.value)) {
      best = { label, value: grant.critRange };
    }
  }
  return best;
}

export interface DamageTraits {
  readonly resist: ReadonlyMap<DamageType, string>;
  readonly immune: ReadonlyMap<DamageType, string>;
  readonly vulnerable: ReadonlyMap<DamageType, string>;
  readonly resistAll: string | null;
}

/** Resistances, immunities and vulnerabilities homebrew adds, with their source. */
export function damageTraits(c: Combatant): DamageTraits {
  const resist = new Map<DamageType, string>();
  const immune = new Map<DamageType, string>();
  const vulnerable = new Map<DamageType, string>();
  let resistAll: string | null = null;
  for (const { label, grant } of grantsOf(c)) {
    for (const t of grant.resist ?? []) if (!resist.has(t)) resist.set(t, label);
    for (const t of grant.immune ?? []) if (!immune.has(t)) immune.set(t, label);
    for (const t of grant.vulnerable ?? []) if (!vulnerable.has(t)) vulnerable.set(t, label);
    if (grant.resistAll && resistAll === null) resistAll = label;
  }
  return { resist, immune, vulnerable, resistAll };
}

// ── Uses and charges ──────────────────────────────────────────────────────

/** Create missing pools for every effect and feature with uses. */
export function initResources(c: Combatant): Result<Combatant, string> {
  const ctx = contextOf(c);
  const pools: Record<string, ResourcePool> = { ...(c.resources ?? {}) };
  for (const a of c.homebrew ?? []) {
    const entries = [
      ...a.def.effects.map((e) => ({ name: e.name, uses: e.uses })),
      ...a.def.features.map((f) => ({ name: f.name, uses: f.uses })),
    ];
    for (const { name, uses } of entries) {
      if (!uses) continue;
      const key = resourceKey(a.def.id, name);
      if (pools[key]) continue;
      const max = evalFormula(uses.max, ctx);
      if (!max.ok) return err(`${a.def.name}: ${name}: ${max.error}`);
      let regain: ResourcePool["regain"];
      if (uses.regain && "dice" in uses.regain) regain = { dice: uses.regain.dice };
      if (uses.regain && "formula" in uses.regain) {
        const r = evalFormula(uses.regain.formula, ctx);
        if (!r.ok) return err(`${a.def.name}: ${name}: ${r.error}`);
        regain = { amount: r.value };
      }
      pools[key] = {
        label: name === a.def.name ? name : `${a.def.name}: ${name}`,
        max: Math.max(0, max.value),
        used: 0,
        per: uses.per,
        ...(regain ? { regain } : {}),
      };
    }
  }
  return ok({ ...c, resources: pools });
}

export function remaining(pool: ResourcePool): number {
  return Math.max(0, pool.max - pool.used);
}

/** Find a pool by key or by (case-insensitive) label or name. */
export function findResource(c: Combatant, ref: string): Result<string, string> {
  const pools = c.resources ?? {};
  const wanted = ref.trim().toLowerCase();
  if (pools[ref]) return ok(ref);
  const matches = Object.entries(pools).filter(([key, p]) =>
    p.label.toLowerCase() === wanted
    || p.label.toLowerCase().endsWith(`: ${wanted}`)
    || key.endsWith(`/${slugify(ref)}`));
  if (matches.length === 1) return ok(matches[0]![0]);
  if (matches.length > 1) return err(`"${ref}" matches several: ${matches.map(([, p]) => p.label).join(", ")}`);
  const known = Object.values(pools).map((p) => p.label).join(", ") || "none";
  return err(`${c.name} has no tracked use "${ref}" (has: ${known})`);
}

export function spendUse(c: Combatant, key: string, count = 1): Result<Combatant, string> {
  const pool = c.resources?.[key];
  if (!pool) return err(`${c.name} has no tracked use "${key}"`);
  if (remaining(pool) < count) {
    return err(`${pool.label}: no uses left (${pool.used} of ${pool.max} used${pool.per !== "never" ? `, regained per ${pool.per}` : ""})`);
  }
  return ok({ ...c, resources: { ...c.resources, [key]: { ...pool, used: pool.used + count } } });
}

const RESETS: Record<RestPeriod, readonly (RestPeriod | "never")[]> = {
  "round": ["round"],
  "short-rest": ["short-rest"],
  // A long rest also restores what a short rest would.
  "long-rest": ["short-rest", "long-rest"],
  "dawn": ["dawn"],
};

/** Restore pools that recover on this period. Dice regains roll on the Rng. */
export function resetResources(
  c: Combatant,
  period: RestPeriod,
  rng?: Rng,
): Result<{ combatant: Combatant; notes: string[] }, string> {
  const pools = c.resources;
  if (!pools) return ok({ combatant: c, notes: [] });
  const next: Record<string, ResourcePool> = {};
  const notes: string[] = [];
  for (const [key, pool] of Object.entries(pools)) {
    if (!RESETS[period].includes(pool.per) || pool.used === 0) {
      next[key] = pool;
      continue;
    }
    let regained = pool.used;
    let how = "";
    if (pool.regain && "amount" in pool.regain) regained = Math.min(pool.used, pool.regain.amount);
    if (pool.regain && "dice" in pool.regain) {
      if (!rng) return err(`${pool.label} regains ${pool.regain.dice}, which needs a roll`);
      const r = roll(pool.regain.dice, rng);
      if (!r.ok) return err(`${pool.label}: ${r.error}`);
      regained = Math.min(pool.used, Math.max(0, r.value.total));
      how = ` (${pool.regain.dice} rolled ${r.value.total})`;
    }
    next[key] = { ...pool, used: pool.used - regained };
    if (period !== "round") notes.push(`${pool.label}: regains ${regained}${how} → ${remaining(next[key]!)}/${pool.max}`);
  }
  return ok({ combatant: { ...c, resources: next }, notes });
}

// ── Timed grants and conditions ───────────────────────────────────────────

/**
 * When a duration ends. "Until the end of X's next turn" applied during X's
 * own turn skips the turn in progress; applied at any other time it ends at
 * the end of X's coming turn.
 */
export function expiryFor(
  until: Until,
  ids: { readonly holder: string; readonly target?: string },
  currentTurnId: string | undefined,
): Expiry {
  if (until.kind === "rounds") {
    return { kind: "rounds", of: currentTurnId ?? ids.holder, remaining: until.n };
  }
  const of = until.whose === "holder" ? ids.holder : (ids.target ?? ids.holder);
  return { kind: "end-of-turn", of, skip: currentTurnId === of ? 1 : 0 };
}

export function describeExpiry(e: Expiry, names: (id: string) => string): string {
  return e.kind === "end-of-turn"
    ? `until the end of ${names(e.of)}'s next turn`
    : `for ${e.remaining} round${e.remaining === 1 ? "" : "s"}`;
}

function conditionNote(label: string): string {
  return `homebrew: ${label}`;
}

export function addTimed(c: Combatant, timed: Timed): Combatant {
  const conditions = timed.condition
    ? [...c.conditions, { condition: timed.condition, note: conditionNote(timed.label) }]
    : c.conditions;
  return { ...c, conditions, timed: [...(c.timed ?? []), timed] };
}

function expire(c: Combatant, t: Timed): Combatant {
  const conditions = t.condition
    ? (() => {
        const i = c.conditions.findIndex((a) => a.condition === t.condition && a.note === conditionNote(t.label));
        return i === -1 ? c.conditions : [...c.conditions.slice(0, i), ...c.conditions.slice(i + 1)];
      })()
    : c.conditions;
  return { ...c, conditions };
}

function describeTimed(t: Timed): string {
  return t.condition ? `${t.condition} (${t.label})` : t.label;
}

/** The turn of `endingId` ends: expire what was waiting for it. */
export function endTurn(c: Combatant, endingId: string): { combatant: Combatant; lines: string[] } {
  if (!c.timed || c.timed.length === 0) return { combatant: c, lines: [] };
  let working: Combatant = c;
  const kept: Timed[] = [];
  const lines: string[] = [];
  for (const t of c.timed) {
    if (t.expires.kind === "end-of-turn" && t.expires.of === endingId) {
      if (t.expires.skip > 0) {
        kept.push({ ...t, expires: { ...t.expires, skip: t.expires.skip - 1 } });
      } else {
        working = expire(working, t);
        lines.push(`${c.name}: ${describeTimed(t)} ends`);
      }
      continue;
    }
    kept.push(t);
  }
  return { combatant: { ...working, timed: kept }, lines };
}

/** The turn of `startingId` begins: count down rounds, refresh per-round uses. */
export function startTurn(c: Combatant, startingId: string): { combatant: Combatant; lines: string[] } {
  let working: Combatant = c;
  const lines: string[] = [];
  if (c.timed && c.timed.length > 0) {
    const kept: Timed[] = [];
    for (const t of c.timed) {
      if (t.expires.kind === "rounds" && t.expires.of === startingId) {
        const left = t.expires.remaining - 1;
        if (left <= 0) {
          working = expire(working, t);
          lines.push(`${c.name}: ${describeTimed(t)} ends`);
          continue;
        }
        kept.push({ ...t, expires: { ...t.expires, remaining: left } });
        continue;
      }
      kept.push(t);
    }
    working = { ...working, timed: kept };
  }
  if (c.id === startingId) {
    const reset = resetResources(working, "round");
    if (reset.ok) working = reset.value.combatant;
  }
  return { combatant: working, lines };
}
