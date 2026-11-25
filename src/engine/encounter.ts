/**
 * Encounter state and the transitions over it.
 *
 * Every transition is a pure function from state to new state plus a
 * description of what happened. Nothing here reads a file, writes a file or
 * generates entropy on its own: randomness arrives as a seed derived from the
 * encounter's own seed and a monotonic roll counter, so each CLI invocation
 * reproduces exactly and every logged roll can be re-run on its own.
 */

import { makeRng, type Rng } from "./rng.ts";
import { type Result, ok, err } from "./result.ts";
import { resolveAttack, type AttackRequest, type AttackOutcome } from "./attack.ts";
import { applyDamage, applyHealing, applyTempHp, type DamagePacket } from "./damage.ts";
import { savingThrow, abilityCheck, concentrationSave, type CheckRequest, type CheckOutcome } from "./checks.ts";
import { rollDeathSave, stabilise, type DeathSaveOutcome } from "./death.ts";
import { rollInitiative, sortInitiative, type InitiativeEntry, type InitiativeOptions } from "./initiative.ts";
import { canApply, effectiveSpeed, isIncapacitated } from "./conditions.ts";
import { resolveSpell, type SpellRequest, type SpellOutcome } from "./spell.ts";
import { spendSlot, restoreSlots, shortRest, longRest, slotsOf, type SlotView, type RestOutcome } from "./resources.ts";
import type { Ability, Combatant, ConditionName } from "./types.ts";
import { endTurn, findResource, remaining, resetResources, spendUse, startTurn } from "./homebrew/active.ts";
import type { RestPeriod } from "./homebrew/types.ts";

export interface LogLine {
  readonly n: number;
  readonly round: number;
  readonly text: string;
  /** Seed used for this action — re-runnable in isolation. */
  readonly seed: string | null;
}

export interface EncounterState {
  readonly name: string;
  readonly seed: string;
  readonly round: number;
  readonly turnIndex: number;
  readonly started: boolean;
  readonly order: readonly InitiativeEntry[];
  readonly combatants: Readonly<Record<string, Combatant>>;
  readonly log: readonly LogLine[];
  readonly rollCount: number;
}

export function createEncounter(name: string, seed: string): EncounterState {
  return {
    name, seed,
    round: 0, turnIndex: 0, started: false,
    order: [], combatants: {}, log: [], rollCount: 0,
  };
}

/** Derive an independent, reproducible Rng for the next action. */
export function nextRng(state: EncounterState): { rng: Rng; seed: string; rollCount: number } {
  const seed = `${state.seed}#${state.rollCount}`;
  return { rng: makeRng(seed), seed, rollCount: state.rollCount + 1 };
}

function appendLog(
  state: EncounterState,
  lines: readonly string[],
  seed: string | null,
): readonly LogLine[] {
  let n = state.log.length;
  return [
    ...state.log,
    ...lines.map((text) => ({ n: n++, round: state.round, text, seed })),
  ];
}

export function getCombatant(state: EncounterState, id: string): Result<Combatant, string> {
  const c = state.combatants[id];
  if (!c) {
    const known = Object.keys(state.combatants).join(", ") || "none";
    return err(`no combatant "${id}" in this encounter (have: ${known})`);
  }
  return ok(c);
}

/** The id of whoever is acting, as an optional field for engine requests. */
function turnIdOf(state: EncounterState): { turnId?: string } {
  const entry = state.started ? state.order[state.turnIndex] : undefined;
  return entry ? { turnId: entry.id } : {};
}

function withCombatant(state: EncounterState, c: Combatant): EncounterState {
  return { ...state, combatants: { ...state.combatants, [c.id]: c } };
}

export function addCombatant(
  state: EncounterState,
  c: Combatant,
): Result<EncounterState, string> {
  if (state.combatants[c.id]) return err(`combatant "${c.id}" is already in this encounter`);
  return ok({
    ...withCombatant(state, c),
    log: appendLog(state, [`${c.name} joins the encounter (AC ${c.ac}, ${c.hp.current}/${c.hp.max} HP)`], null),
  });
}

export function removeCombatant(
  state: EncounterState,
  id: string,
): Result<EncounterState, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;

  const combatants = { ...state.combatants };
  delete combatants[id];

  const order = state.order.filter((e) => e.id !== id);
  const removedIndex = state.order.findIndex((e) => e.id === id);
  // Keep the pointer on the same creature when an earlier entry disappears.
  const turnIndex =
    removedIndex >= 0 && removedIndex < state.turnIndex
      ? Math.max(0, state.turnIndex - 1)
      : Math.min(state.turnIndex, Math.max(0, order.length - 1));

  return ok({
    ...state,
    combatants,
    order,
    turnIndex,
    log: appendLog(state, [`${found.value.name} leaves the encounter`], null),
  });
}

export interface InitiativeRoll {
  readonly entry: InitiativeEntry;
  readonly seed: string;
}

/** Roll initiative for everyone without an entry yet, then sort the order. */
export function rollInitiativeFor(
  state: EncounterState,
  ids: readonly string[],
  options: Record<string, InitiativeOptions> = {},
): Result<{ state: EncounterState; rolls: readonly InitiativeRoll[] }, string> {
  let working = state;
  const rolls: InitiativeRoll[] = [];
  const entries: InitiativeEntry[] = [...state.order.filter((e) => !ids.includes(e.id))];

  for (const id of ids) {
    const found = getCombatant(working, id);
    if (!found.ok) return found;
    const { rng, seed, rollCount } = nextRng(working);
    const entry = rollInitiative(found.value, rng, options[id] ?? {});
    entries.push(entry);
    rolls.push({ entry, seed });
    working = { ...working, rollCount };
  }

  const order = sortInitiative(entries);
  return ok({
    state: {
      ...working,
      order,
      log: appendLog(
        working,
        rolls.map((r) => `${r.entry.name} rolls initiative: ${r.entry.total}`),
        null,
      ),
    },
    rolls,
  });
}

export function startEncounter(state: EncounterState): Result<EncounterState, string> {
  if (state.order.length === 0) return err("nobody has rolled initiative yet");
  if (state.started) return err("encounter has already started");
  return ok({
    ...state,
    started: true,
    round: 1,
    turnIndex: 0,
    log: appendLog({ ...state, round: 1 }, [`Round 1 begins — ${state.order[0]!.name} acts first`], null),
  });
}

export function currentTurn(state: EncounterState): InitiativeEntry | null {
  if (!state.started || state.order.length === 0) return null;
  return state.order[state.turnIndex] ?? null;
}

export function nextTurn(
  state: EncounterState,
): Result<{ state: EncounterState; entry: InitiativeEntry; newRound: boolean }, string> {
  if (!state.started) return err("encounter has not started");
  if (state.order.length === 0) return err("no combatants in the order");

  const nextIndex = (state.turnIndex + 1) % state.order.length;
  const newRound = nextIndex === 0;
  const round = newRound ? state.round + 1 : state.round;
  const entry = state.order[nextIndex]!;

  const lines: string[] = [];

  // Homebrew durations: those waiting on the end of the turn that just
  // finished expire now; round counts tick at the start of the next.
  const ending = state.order[state.turnIndex]!;
  const timed: Record<string, Combatant> = {};
  for (const [id, c] of Object.entries(state.combatants)) {
    const ended = endTurn(c, ending.id);
    const started = startTurn(ended.combatant, entry.id);
    timed[id] = started.combatant;
    lines.push(...ended.lines, ...started.lines);
  }

  lines.push(...(newRound ? [`Round ${round} begins`, `${entry.name}'s turn`] : [`${entry.name}'s turn`]));

  // A creature regains its reaction at the start of its own turn.
  const acting = timed[entry.id];
  const combatants = acting?.reactionUsed
    ? { ...timed, [entry.id]: { ...acting, reactionUsed: false } }
    : timed;

  const advanced = { ...state, turnIndex: nextIndex, round, combatants };

  return ok({ state: { ...advanced, log: appendLog(advanced, lines, null) }, entry, newRound });
}

export interface AttackParams {
  readonly attackerId: string;
  readonly targetId: string;
  readonly weapon: string;
  readonly attackBonus: number;
  readonly damage: AttackRequest["damage"];
  readonly within5?: boolean;
  /** Distance in feet; when given it decides adjacency and range effects. */
  readonly distance?: number;
  readonly range?: number;
  readonly longRange?: number;
  readonly threatened?: boolean;
  /** Spend the attacker's reaction, for an opportunity attack. */
  readonly reaction?: boolean;
  readonly cover?: AttackRequest["cover"];
  readonly critRange?: number;
  readonly advantage?: readonly string[];
  readonly disadvantage?: readonly string[];
  readonly force?: boolean;
  /** Source tags, e.g. "unphased" — see the homebrew effects language. */
  readonly tags?: readonly string[];
  /** Optional homebrew effects the DM opts in to, by name. */
  readonly optIn?: readonly string[];
}

export interface AttackReport {
  readonly outcome: AttackOutcome;
  readonly seed: string;
  readonly concentration: CheckOutcome | null;
  readonly concentrationSeed: string | null;
  readonly concentrationBroken: boolean;
}

export function performAttack(
  state: EncounterState,
  params: AttackParams,
): Result<{ state: EncounterState; report: AttackReport }, string> {
  const attacker = getCombatant(state, params.attackerId);
  if (!attacker.ok) return attacker;
  const target = getCombatant(state, params.targetId);
  if (!target.ok) return target;

  // An opportunity attack costs the reaction before any dice are rolled, so a
  // creature that has none never gets a free swing.
  let working0 = state;
  if (params.reaction === true) {
    const spent = useReaction(working0, params.attackerId);
    if (!spent.ok) return spent;
    working0 = spent.value.state;
  }

  const { rng, seed, rollCount } = nextRng(working0);
  const resolved = resolveAttack(
    {
      attacker: attacker.value,
      target: target.value,
      weapon: params.weapon,
      attackBonus: params.attackBonus,
      damage: params.damage,
      within5: params.within5 ?? true,
      ...(params.distance !== undefined ? { distance: params.distance } : {}),
      ...(params.range !== undefined ? { range: params.range } : {}),
      ...(params.longRange !== undefined ? { longRange: params.longRange } : {}),
      ...(params.threatened !== undefined ? { threatened: params.threatened } : {}),
      cover: params.cover,
      critRange: params.critRange,
      advantage: params.advantage,
      disadvantage: params.disadvantage,
      force: params.force,
      ...(params.tags !== undefined ? { tags: params.tags } : {}),
      ...(params.optIn !== undefined ? { optIn: params.optIn } : {}),
      ...turnIdOf(working0),
    },
    rng,
  );
  if (!resolved.ok) return resolved;

  const outcome = resolved.value;
  let working: EncounterState = { ...working0, rollCount };
  const lines: string[] = [];

  if (params.attackerId !== params.targetId) working = withCombatant(working, outcome.attacker);

  if (!outcome.hit) {
    lines.push(
      `${attacker.value.name} misses ${target.value.name} with ${outcome.weapon} ` +
        `(${outcome.roll.total} vs AC ${outcome.effectiveAc})`,
    );
    for (const note of outcome.effectNotes) lines.push(`  ${note}`);
    return ok({
      state: { ...working, log: appendLog(working, lines, seed) },
      report: { outcome, seed, concentration: null, concentrationSeed: null, concentrationBroken: false },
    });
  }

  const damage = outcome.damage!;
  working = withCombatant(working, outcome.target);
  lines.push(
    `${attacker.value.name} ${outcome.critical ? "critically hits" : "hits"} ${target.value.name} ` +
      `with ${outcome.weapon} for ${damage.adjustedTotal} damage ` +
      `(${damage.hpBefore} → ${damage.hpAfter} HP)`,
  );
  for (const p of damage.packets) for (const h of p.homebrew ?? []) lines.push(`  ${h}`);
  for (const note of damage.notes) lines.push(`  ${note}`);
  for (const note of outcome.effectNotes) lines.push(`  ${note}`);
  if (damage.droppedToZero && !damage.died) lines.push(`  ${target.value.name} falls unconscious at 0 HP`);
  if (damage.died) lines.push(`  ${target.value.name} dies`);

  // Concentration is checked here, at the boundary, because applyDamage is pure.
  let concentration: CheckOutcome | null = null;
  let concentrationSeed: string | null = null;
  let concentrationBroken = false;

  if (damage.concentrationCheck) {
    const next = nextRng(working);
    concentrationSeed = next.seed;
    concentration = concentrationSave(outcome.target, damage.concentrationCheck.dc, next.rng);
    working = { ...working, rollCount: next.rollCount };

    if (!concentration.success) {
      concentrationBroken = true;
      working = withCombatant(working, { ...outcome.target, concentration: null });
      lines.push(`  concentration on ${damage.concentrationCheck.spell} is broken (${concentration.roll?.total} vs DC ${damage.concentrationCheck.dc})`);
    } else {
      lines.push(`  concentration on ${damage.concentrationCheck.spell} holds (${concentration.roll?.total} vs DC ${damage.concentrationCheck.dc})`);
    }
  }

  return ok({
    state: { ...working, log: appendLog(working, lines, seed) },
    report: { outcome, seed, concentration, concentrationSeed, concentrationBroken },
  });
}

export function damageCombatant(
  state: EncounterState,
  id: string,
  packets: readonly DamagePacket[],
  options: { critical?: boolean; tags?: readonly string[] } = {},
): Result<{ state: EncounterState; outcome: ReturnType<typeof applyDamage>; concentration: CheckOutcome | null }, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;

  const outcome = applyDamage(found.value, packets, { ...options, ...turnIdOf(state) });
  let working = withCombatant(state, outcome.combatant);
  const lines = [
    `${found.value.name} takes ${outcome.adjustedTotal} damage (${outcome.hpBefore} → ${outcome.hpAfter} HP)`,
    ...outcome.packets.flatMap((p) => (p.homebrew ?? []).map((h) => `  ${h}`)),
    ...outcome.notes.map((n) => `  ${n}`),
  ];
  if (outcome.died) lines.push(`  ${found.value.name} dies`);

  let concentration: CheckOutcome | null = null;
  if (outcome.concentrationCheck) {
    const next = nextRng(working);
    concentration = concentrationSave(outcome.combatant, outcome.concentrationCheck.dc, next.rng);
    working = { ...working, rollCount: next.rollCount };
    if (!concentration.success) {
      working = withCombatant(working, { ...outcome.combatant, concentration: null });
      lines.push(`  concentration on ${outcome.concentrationCheck.spell} is broken`);
    } else {
      lines.push(`  concentration on ${outcome.concentrationCheck.spell} holds`);
    }
  }

  return ok({ state: { ...working, log: appendLog(working, lines, null) }, outcome, concentration });
}

export function healCombatant(
  state: EncounterState,
  id: string,
  amount: number,
): Result<{ state: EncounterState; outcome: ReturnType<typeof applyHealing> }, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;
  const outcome = applyHealing(found.value, amount);
  const working = withCombatant(state, outcome.combatant);
  return ok({
    state: {
      ...working,
      log: appendLog(working, [
        `${found.value.name} heals ${outcome.healed} (${outcome.hpBefore} → ${outcome.hpAfter} HP)`,
        ...outcome.notes.map((n) => `  ${n}`),
      ], null),
    },
    outcome,
  });
}

export function grantTempHp(
  state: EncounterState,
  id: string,
  amount: number,
): Result<{ state: EncounterState; note: string }, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;
  const { combatant, note } = applyTempHp(found.value, amount);
  const working = withCombatant(state, combatant);
  return ok({ state: { ...working, log: appendLog(working, [`${found.value.name}: ${note}`], null) }, note });
}

export function setCondition(
  state: EncounterState,
  id: string,
  condition: ConditionName,
  on: boolean,
  source?: string,
): Result<{ state: EncounterState; changed: boolean; note: string }, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;
  const c = found.value;

  if (on && !canApply(c, condition)) {
    return ok({ state, changed: false, note: `${c.name} is immune to ${condition}` });
  }

  const has = c.conditions.some((a) => a.condition === condition);
  if (on === has) {
    return ok({ state, changed: false, note: `${c.name} is already ${on ? "" : "not "}${condition}` });
  }

  const conditions = on
    ? [...c.conditions, { condition, source }]
    : c.conditions.filter((a) => a.condition !== condition);

  // Losing consciousness or being incapacitated ends concentration.
  const updated: Combatant = { ...c, conditions };
  const breaks = on && isIncapacitated(updated) && updated.concentration !== null;

  const working = withCombatant(state, breaks ? { ...updated, concentration: null } : updated);
  const note = `${c.name} is ${on ? "now" : "no longer"} ${condition}`;
  const lines = breaks
    ? [note, `  concentration on ${c.concentration!.spell} ends (incapacitated)`]
    : [note];

  return ok({ state: { ...working, log: appendLog(working, lines, null) }, changed: true, note });
}

export function setExhaustion(
  state: EncounterState,
  id: string,
  level: number,
): Result<{ state: EncounterState; level: number; dead: boolean }, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;
  const clamped = Math.max(0, Math.min(6, Math.trunc(level)));
  const updated = { ...found.value, exhaustion: clamped };
  const working = withCombatant(state, updated);
  const dead = clamped >= 6;
  const lines = [
    `${found.value.name}: exhaustion ${found.value.exhaustion} → ${clamped} (${-2 * clamped} to d20 tests, ${-5 * clamped} ft speed)`,
  ];
  if (dead) lines.push(`  ${found.value.name} dies of exhaustion at level 6`);
  return ok({ state: { ...working, log: appendLog(working, lines, null) }, level: clamped, dead });
}

export function performCheck(
  state: EncounterState,
  kind: "save" | "check",
  params: Omit<CheckRequest, "creature"> & { id: string },
): Result<{ state: EncounterState; outcome: CheckOutcome; seed: string }, string> {
  const found = getCombatant(state, params.id);
  if (!found.ok) return found;

  const { rng, seed, rollCount } = nextRng(state);
  const request: CheckRequest = { ...params, creature: found.value };
  const outcome = kind === "save" ? savingThrow(request, rng) : abilityCheck(request, rng);
  const working = { ...state, rollCount };

  const detail = outcome.autoFailed
    ? outcome.reason
    : `${outcome.roll!.total} vs DC ${outcome.dc}`;
  return ok({
    state: {
      ...working,
      log: appendLog(working, [
        `${found.value.name} ${outcome.label}: ${detail} — ${outcome.success ? "success" : "failure"}`,
      ], seed),
    },
    outcome,
    seed,
  });
}

export function performDeathSave(
  state: EncounterState,
  id: string,
): Result<{ state: EncounterState; outcome: DeathSaveOutcome; seed: string }, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;

  const { rng, seed, rollCount } = nextRng(state);
  const rolled = rollDeathSave(found.value, rng);
  if (!rolled.ok) return rolled;

  const outcome = rolled.value;
  const working = withCombatant({ ...state, rollCount }, outcome.combatant);
  const saves = outcome.combatant.deathSaves;

  return ok({
    state: {
      ...working,
      log: appendLog(working, [
        `${found.value.name} death save: ${outcome.roll.total} — ${outcome.success ? "success" : "failure"} (${saves.successes} successes, ${saves.failures} failures)`,
        ...outcome.notes.map((n) => `  ${n}`),
      ], seed),
    },
    outcome,
    seed,
  });
}

export function stabiliseCombatant(
  state: EncounterState,
  id: string,
): Result<EncounterState, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;
  const result = stabilise(found.value);
  if (!result.ok) return result;
  const working = withCombatant(state, result.value);
  return ok({ ...working, log: appendLog(working, [`${found.value.name} is stabilised`], null) });
}

export function setConcentration(
  state: EncounterState,
  id: string,
  spell: string | null,
): Result<EncounterState, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;
  if (spell !== null && isIncapacitated(found.value)) {
    return err(`${found.value.name} is incapacitated and cannot concentrate`);
  }
  const updated: Combatant = {
    ...found.value,
    concentration: spell === null ? null : { spell, since: state.round },
  };
  const working = withCombatant(state, updated);
  const line = spell === null
    ? `${found.value.name} stops concentrating`
    : `${found.value.name} concentrates on ${spell}`;
  return ok({ ...working, log: appendLog(working, [line], null) });
}

/** Everything a status display needs, derived rather than stored. */
export interface CombatantStatus {
  readonly combatant: Combatant;
  readonly speed: number;
  readonly incapacitated: boolean;
  readonly isCurrentTurn: boolean;
  readonly initiative: number | null;
}

export function status(state: EncounterState): readonly CombatantStatus[] {
  const current = currentTurn(state);
  const ordered = state.order.length > 0
    ? state.order.map((e) => state.combatants[e.id]).filter((c): c is Combatant => c !== undefined)
    : Object.values(state.combatants);

  return ordered.map((c) => ({
    combatant: c,
    speed: effectiveSpeed(c),
    incapacitated: isIncapacitated(c),
    isCurrentTurn: current?.id === c.id,
    initiative: state.order.find((e) => e.id === c.id)?.total ?? null,
  }));
}

export { type Ability };


// ── Spells, resources and rests ───────────────────────────────────────────

export interface CastParams {
  readonly casterId: string;
  readonly name: string;
  readonly dc: number;
  readonly ability: Ability;
  readonly damage: SpellRequest["damage"];
  readonly onSuccess: SpellRequest["onSuccess"];
  readonly targetIds: readonly string[];
  /** Spend a slot of this level from the caster. */
  readonly slotLevel?: number;
  /** Start concentrating on this spell once it resolves. */
  readonly concentrate?: boolean;
  readonly tags?: readonly string[];
  readonly optIn?: readonly string[];
  readonly effectTarget?: string;
}

export interface CastReport {
  readonly outcome: SpellOutcome;
  readonly seed: string;
  readonly slotSpent: number | null;
  readonly concentrationChecks: readonly { targetId: string; check: CheckOutcome; broken: boolean }[];
}

export function castSpell(
  state: EncounterState,
  params: CastParams,
): Result<{ state: EncounterState; report: CastReport }, string> {
  const caster = getCombatant(state, params.casterId);
  if (!caster.ok) return caster;

  const targets: Combatant[] = [];
  for (const id of params.targetIds) {
    const found = getCombatant(state, id);
    if (!found.ok) return found;
    targets.push(found.value);
  }

  let working = state;

  // Spend the slot first: a caster without the slot never rolls the spell.
  let slotSpent: number | null = null;
  if (params.slotLevel !== undefined) {
    const spent = spendSlot(caster.value, params.slotLevel);
    if (!spent.ok) return spent;
    working = withCombatant(working, spent.value);
    slotSpent = params.slotLevel;
  }

  const { rng, seed, rollCount } = nextRng(working);
  const resolved = resolveSpell(
    {
      name: params.name,
      dc: params.dc,
      ability: params.ability,
      damage: params.damage,
      onSuccess: params.onSuccess,
      targets,
      caster: working.combatants[params.casterId]!,
      ...(params.tags !== undefined ? { tags: params.tags } : {}),
      ...(params.optIn !== undefined ? { optIn: params.optIn } : {}),
      ...(params.effectTarget !== undefined ? { effectTarget: params.effectTarget } : {}),
      ...turnIdOf(working),
    },
    rng,
  );
  if (!resolved.ok) return resolved;

  working = { ...working, rollCount };
  const outcome = resolved.value;
  if (outcome.caster !== null && !params.targetIds.includes(params.casterId)) {
    working = withCombatant(working, outcome.caster);
  }
  const lines: string[] = [
    `${caster.value.name} casts ${params.name} (DC ${params.dc} ${params.ability.toUpperCase()})` +
      (slotSpent ? ` using a level ${slotSpent} slot` : ""),
  ];
  if (outcome.damageRolls.length > 0) {
    lines.push(`  damage rolled once for the area: ${outcome.baseTotal}`);
  }
  for (const note of outcome.effectNotes) lines.push(`  ${note}`);

  const concentrationChecks: { targetId: string; check: CheckOutcome; broken: boolean }[] = [];

  for (const t of outcome.targets) {
    if (t.damage === null) {
      lines.push(
        `  ${t.targetName}: ${t.save.autoFailed ? t.save.reason : t.save.roll!.total} vs DC ${params.dc}` +
          ` — ${t.save.success ? "success" : "failure"}${t.avoided ? ", no damage" : ""}`,
      );
      continue;
    }

    working = withCombatant(working, t.damage.combatant);
    lines.push(
      `  ${t.targetName}: ${t.save.autoFailed ? "auto-fail" : t.save.roll!.total} vs DC ${params.dc} — ` +
        `${t.save.success ? "success" : "failure"}${t.halved ? " (half)" : ""}, ` +
        `${t.damage.adjustedTotal} damage (${t.damage.hpBefore} → ${t.damage.hpAfter} HP)`,
    );
    for (const p of t.damage.packets) for (const h of p.homebrew ?? []) lines.push(`    ${h}`);
    for (const note of t.damage.notes) lines.push(`    ${note}`);
    if (t.damage.died) lines.push(`    ${t.targetName} dies`);

    if (t.damage.concentrationCheck) {
      const next = nextRng(working);
      const check = concentrationSave(t.damage.combatant, t.damage.concentrationCheck.dc, next.rng);
      working = { ...working, rollCount: next.rollCount };
      const broken = !check.success;
      if (broken) {
        working = withCombatant(working, { ...t.damage.combatant, concentration: null });
        lines.push(`    concentration on ${t.damage.concentrationCheck.spell} is broken`);
      }
      concentrationChecks.push({ targetId: t.targetId, check, broken });
    }
  }

  if (params.concentrate === true) {
    const started = setConcentration(working, params.casterId, params.name);
    if (!started.ok) return started;
    working = started.value;
  }

  return ok({
    state: { ...working, log: appendLog(working, lines, seed) },
    report: { outcome, seed, slotSpent, concentrationChecks },
  });
}

/** Resolve the same attack several times, as Extra Attack or Multiattack. */
export function performAttacks(
  state: EncounterState,
  params: AttackParams,
  times: number,
): Result<{ state: EncounterState; reports: readonly AttackReport[] }, string> {
  const count = Math.max(1, Math.trunc(times));
  let working = state;
  const reports: AttackReport[] = [];

  for (let i = 0; i < count; i++) {
    const result = performAttack(working, params);
    if (!result.ok) {
      // A later swing may be refused because the target has already fallen;
      // earlier swings still happened and are kept.
      if (reports.length === 0) return result;
      return ok({ state: working, reports });
    }
    working = result.value.state;
    reports.push(result.value.report);
  }
  return ok({ state: working, reports });
}

export function spellSlots(state: EncounterState, id: string): Result<readonly SlotView[], string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;
  return ok(slotsOf(found.value));
}

export function useSlot(
  state: EncounterState,
  id: string,
  level: number,
): Result<{ state: EncounterState; note: string }, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;
  const spent = spendSlot(found.value, level);
  if (!spent.ok) return spent;

  const pool = spent.value.spellSlots![String(level)]!;
  const note = `${found.value.name} spends a level ${level} slot (${pool.max - pool.used} of ${pool.max} left)`;
  const working = withCombatant(state, spent.value);
  return ok({ state: { ...working, log: appendLog(working, [note], null) }, note });
}

export function regainSlots(
  state: EncounterState,
  id: string,
  level: number | null,
): Result<{ state: EncounterState; note: string }, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;
  const restored = restoreSlots(found.value, level);
  const note = `${found.value.name} regains ${level === null ? "all spell slots" : `level ${level} slots`}`;
  const working = withCombatant(state, restored);
  return ok({ state: { ...working, log: appendLog(working, [note], null) }, note });
}

export function restShort(
  state: EncounterState,
  id: string,
  diceToSpend: number,
): Result<{ state: EncounterState; outcome: RestOutcome; seed: string }, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;

  const { rng, seed, rollCount } = nextRng(state);
  const rested = shortRest(found.value, diceToSpend, rng);
  if (!rested.ok) return rested;

  const reset = resetResources(rested.value.combatant, "short-rest", rng);
  if (!reset.ok) return reset;
  const outcome: RestOutcome = {
    ...rested.value,
    combatant: reset.value.combatant,
    notes: [...rested.value.notes, ...reset.value.notes],
  };
  const working = withCombatant({ ...state, rollCount }, outcome.combatant);
  return ok({
    state: {
      ...working,
      log: appendLog(working, [
        `${found.value.name} takes a short rest: +${outcome.healed} HP`,
        ...outcome.notes.map((n) => `  ${n}`),
      ], seed),
    },
    outcome,
    seed,
  });
}

export function restLong(
  state: EncounterState,
  ids: readonly string[],
): Result<{ state: EncounterState; outcomes: readonly { id: string; outcome: RestOutcome }[] }, string> {
  let working = state;
  const outcomes: { id: string; outcome: RestOutcome }[] = [];

  for (const id of ids) {
    const found = getCombatant(working, id);
    if (!found.ok) return found;
    const rested = longRest(found.value);
    const { rng, rollCount } = nextRng(working);
    working = { ...working, rollCount };
    const reset = resetResources(rested.combatant, "long-rest", rng);
    if (!reset.ok) return reset;
    const outcome: RestOutcome = {
      ...rested,
      combatant: reset.value.combatant,
      notes: [...rested.notes, ...reset.value.notes],
    };
    working = withCombatant(working, outcome.combatant);
    working = {
      ...working,
      log: appendLog(working, [
        `${found.value.name} finishes a long rest`,
        ...outcome.notes.map((n) => `  ${n}`),
      ], null),
    };
    outcomes.push({ id, outcome });
  }
  return ok({ state: working, outcomes });
}

/**
 * Dawn: homebrew uses and charges that recover "per dawn" regain, rolling any
 * dice-based regain. Nothing else about a creature changes.
 */
export function passDawn(
  state: EncounterState,
  ids: readonly string[],
): Result<{ state: EncounterState; notes: readonly string[] }, string> {
  return recover(state, ids, "dawn", "dawn breaks");
}

function recover(
  state: EncounterState,
  ids: readonly string[],
  period: RestPeriod,
  banner: string,
): Result<{ state: EncounterState; notes: readonly string[] }, string> {
  let working = state;
  const notes: string[] = [];
  for (const id of ids) {
    const found = getCombatant(working, id);
    if (!found.ok) return found;
    const { rng, seed, rollCount } = nextRng(working);
    const reset = resetResources(found.value, period, rng);
    if (!reset.ok) return reset;
    working = withCombatant({ ...working, rollCount }, reset.value.combatant);
    const lines = [`${found.value.name}: ${banner}`, ...reset.value.notes.map((n) => `  ${n}`)];
    if (reset.value.notes.length === 0) lines.push("  nothing to regain");
    working = { ...working, log: appendLog(working, lines, seed) };
    notes.push(...lines);
  }
  return ok({ state: working, notes });
}

/** Spend one use or charge of a homebrew effect or feature by name. */
export function useResource(
  state: EncounterState,
  id: string,
  ref: string,
  count = 1,
): Result<{ state: EncounterState; note: string }, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;
  const key = findResource(found.value, ref);
  if (!key.ok) return key;
  const spent = spendUse(found.value, key.value, count);
  if (!spent.ok) return spent;
  const pool = spent.value.resources![key.value]!;
  const note = `${found.value.name} uses ${pool.label}${count > 1 ? ` ×${count}` : ""} (${remaining(pool)}/${pool.max} left)`;
  const working = withCombatant(state, spent.value);
  return ok({ state: { ...working, log: appendLog(working, [note], null) }, note });
}

/** Replace a combatant wholesale — for attaching or detaching homebrew mid-fight. */
export function replaceCombatant(
  state: EncounterState,
  c: Combatant,
  note: string,
): Result<EncounterState, string> {
  const found = getCombatant(state, c.id);
  if (!found.ok) return found;
  const working = withCombatant(state, c);
  return ok({ ...working, log: appendLog(working, [note], null) });
}

export function useReaction(
  state: EncounterState,
  id: string,
): Result<{ state: EncounterState; note: string }, string> {
  const found = getCombatant(state, id);
  if (!found.ok) return found;
  if (found.value.reactionUsed === true) {
    return err(`${found.value.name} has already used a reaction this round`);
  }
  if (isIncapacitated(found.value)) {
    return err(`${found.value.name} is incapacitated and cannot take reactions`);
  }
  const working = withCombatant(state, { ...found.value, reactionUsed: true });
  const note = `${found.value.name} uses their reaction`;
  return ok({ state: { ...working, log: appendLog(working, [note], null) }, note });
}
