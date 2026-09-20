#!/usr/bin/env node
/**
 * dnd — a deterministic rules engine for running D&D 2024 at the table.
 *
 * This file is the edge: it parses arguments, reads and writes files, and
 * prints. Every rule and every piece of arithmetic lives in src/engine, which
 * this module only calls. Nothing here decides an outcome.
 */

import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { roll as rollDice, parseDice, diceCount, range as diceRange } from "../engine/dice.ts";
import { makeRng, makeFixedRng, FixedRngExhausted } from "../engine/rng.ts";
import { type Result, ok, err } from "../engine/result.ts";
import {
  createEncounter, addCombatant, removeCombatant, rollInitiativeFor, startEncounter,
  nextTurn, currentTurn, performAttack, damageCombatant, healCombatant, grantTempHp,
  setCondition, setExhaustion, performCheck, performDeathSave, stabiliseCombatant,
  setConcentration, status, getCombatant, castSpell, performAttacks, spellSlots,
  useSlot, regainSlots, restShort, restLong, useReaction, type EncounterState,
} from "../engine/encounter.ts";
import { loadEncounter, saveEncounter, encounterPath, listEncounters } from "../adapters/store.ts";
import { findSheet, listSheets } from "../adapters/sheets.ts";
import {
  describeDice, formatAttack, formatCheck, formatDeathSave, formatInitiative,
  formatStatus, formatLog,
} from "../adapters/format.ts";
import { runImport } from "./import-run.ts";
import { fetchMonster, lookup, type LookupKind } from "./lookup-run.ts";
import { generateMerchant, shopKinds } from "../engine/generate/merchant.ts";
import { generateSettlement, settlementSizes } from "../engine/generate/settlement.ts";
import { generateWilderness, terrainNames, type WildernessOptions } from "../engine/generate/wilderness.ts";
import { formatMerchant, formatSettlement, formatWilderness } from "../adapters/generate-format.ts";
import {
  parseDamageSpecs, parseFlatDamage, parseAbility, parseCondition, parseCover,
  parseInteger, parseSuppliedDice,
} from "./args.ts";
import type { DamagePacket } from "../engine/damage.ts";
import { spellSaveDc } from "../engine/types.ts";
import { formatCast, formatSlots } from "../adapters/format.ts";
import type { InitiativeOptions } from "../engine/initiative.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const ENCOUNTER_DIR = join(ROOT, "encounters");
const SHEET_DIRS = [join(ROOT, "data", "party"), join(ROOT, "data", "monsters")];

const HELP = `dnd — D&D 2024 rules engine

Encounter setup
  new <name> [--seed S]              start a fresh encounter
  add <sheet> [--as ID] [--count N]  add a stat block from data/
  remove <id>                        remove a combatant
  init [ids...] [--all]              roll initiative (--fixed id=12 to place)
  start                              begin round 1
  next                               advance the turn
  status                             show the board
  log [--limit N]                    show recent events

Resolution
  attack <attacker> <target> [--weapon NAME | --bonus N --damage EXPR:TYPE]
         [--distance FEET] [--threatened] [--reaction]
         [--adv REASON] [--dis REASON] [--cover half|three-quarters|total]
         [--ranged] [--crit-range N] [--times N] [--force]
  cast <caster> <spell> --save ABILITY --damage EXPR:TYPE --target ID...
       [--dc N] [--on-success half|none] [--slot N] [--concentrate]
  damage <target> <AMOUNT:TYPE>...   apply damage directly
  heal <target> <amount>
  temphp <target> <amount>
  save <target> <ability> <dc> [--proficient] [--adv R] [--dis R]
  check <target> <ability> <dc> [--proficient] [--expertise]
  deathsave <target>
  stabilize <target>
  condition <target> <name> [--off] [--source ID]
  exhaustion <target> <level>
  concentrate <target> <spell> | concentrate <target> --off
  reaction <target>                  spend this round's reaction

Resources
  slots <id> [--use N] [--restore N|all]
  rest short <id> [--hit-dice N]
  rest long [ids...]                 defaults to every player character

SRD reference
  lookup monster|spell|condition <name>
  fetch <monster name> [--as ID] [--dry-run]   write a stat block to data/monsters

Characters
  import <id|url>                    import a character from D&D Beyond
  import --from <file>               import a saved payload
         [--out DIR] [--raw FILE] [--dry-run]

Generation
  gen merchant [--kind KIND] [--lines N]
  gen town [--size hamlet|village|town|city] [--shops N]
  gen wilderness [--width N] [--height N] [--terrain T] [--scale MILES]

Utility
  roll <expr> [--seed S] [--dice 17,4]   a standalone roll
  sheets                                  list available stat blocks
  encounters                              list saved encounters

Global flags
  --encounter NAME   which encounter file to use (default: current)
  --json             machine-readable output
  --dice 17,4        supply physical die results instead of rolling

Every roll prints the seed that produced it. Re-run any roll with
  dnd roll <expr> --seed <that seed>
`;

const options = {
  encounter: { type: "string" as const },
  json: { type: "boolean" as const },
  seed: { type: "string" as const },
  dice: { type: "string" as const },
  as: { type: "string" as const },
  count: { type: "string" as const },
  all: { type: "boolean" as const },
  fixed: { type: "string" as const, multiple: true },
  weapon: { type: "string" as const },
  bonus: { type: "string" as const },
  damage: { type: "string" as const, multiple: true },
  adv: { type: "string" as const, multiple: true },
  dis: { type: "string" as const, multiple: true },
  cover: { type: "string" as const },
  ranged: { type: "boolean" as const },
  "crit-range": { type: "string" as const },
  force: { type: "boolean" as const },
  off: { type: "boolean" as const },
  source: { type: "string" as const },
  proficient: { type: "boolean" as const },
  expertise: { type: "boolean" as const },
  limit: { type: "string" as const },
  from: { type: "string" as const },
  out: { type: "string" as const },
  raw: { type: "string" as const },
  "dry-run": { type: "boolean" as const },
  dc: { type: "string" as const },
  save: { type: "string" as const },
  target: { type: "string" as const, multiple: true },
  targets: { type: "string" as const },
  "on-success": { type: "string" as const },
  slot: { type: "string" as const },
  concentrate: { type: "boolean" as const },
  times: { type: "string" as const },
  use: { type: "string" as const },
  restore: { type: "string" as const },
  "hit-dice": { type: "string" as const },
  kind: { type: "string" as const },
  size: { type: "string" as const },
  width: { type: "string" as const },
  height: { type: "string" as const },
  terrain: { type: "string" as const },
  shops: { type: "string" as const },
  lines: { type: "string" as const },
  scale: { type: "string" as const },
  distance: { type: "string" as const },
  threatened: { type: "boolean" as const },
  reaction: { type: "boolean" as const },
  help: { type: "boolean" as const, short: "h" },
};

interface Flags {
  encounter?: string;
  json?: boolean;
  seed?: string;
  dice?: string;
  as?: string;
  count?: string;
  all?: boolean;
  fixed?: string[];
  weapon?: string;
  bonus?: string;
  damage?: string[];
  adv?: string[];
  dis?: string[];
  cover?: string;
  ranged?: boolean;
  "crit-range"?: string;
  force?: boolean;
  off?: boolean;
  source?: string;
  proficient?: boolean;
  expertise?: boolean;
  limit?: string;
  from?: string;
  out?: string;
  raw?: string;
  "dry-run"?: boolean;
  dc?: string;
  save?: string;
  target?: string[];
  targets?: string;
  "on-success"?: string;
  slot?: string;
  concentrate?: boolean;
  times?: string;
  use?: string;
  restore?: string;
  "hit-dice"?: string;
  kind?: string;
  size?: string;
  width?: string;
  height?: string;
  terrain?: string;
  shops?: string;
  lines?: string;
  scale?: string;
  distance?: string;
  threatened?: boolean;
  reaction?: boolean;
  help?: boolean;
}

interface Emission {
  readonly text: string;
  readonly json?: unknown;
}

type Handler = (
  positionals: readonly string[],
  flags: Flags,
) => Promise<Result<Emission, string>>;

function statePath(flags: Flags): string {
  return encounterPath(ENCOUNTER_DIR, flags.encounter ?? "current");
}

async function withState(
  flags: Flags,
  fn: (state: EncounterState) => Result<{ state: EncounterState; emission: Emission }, string>,
): Promise<Result<Emission, string>> {
  const path = statePath(flags);
  const loaded = await loadEncounter(path);
  if (!loaded.ok) return loaded;

  const applied = fn(loaded.value);
  if (!applied.ok) return applied;

  const saved = await saveEncounter(path, applied.value.state);
  if (!saved.ok) return saved;
  return ok(applied.value.emission);
}

async function readState(flags: Flags): Promise<Result<EncounterState, string>> {
  return loadEncounter(statePath(flags));
}

// ── Commands ──────────────────────────────────────────────────────────────

const cmdRoll: Handler = async (positionals, flags) => {
  const expression = positionals[0];
  if (!expression) return err(`usage: dnd roll <expression>   e.g. dnd roll 2d6+3`);

  const parsed = parseDice(expression);
  if (!parsed.ok) return parsed;

  const supplied = parseSuppliedDice(flags.dice);
  if (!supplied.ok) return supplied;

  const needed = diceCount(parsed.value);
  if (supplied.value && supplied.value.length !== needed) {
    return err(
      `${expression} needs ${needed} die result${needed === 1 ? "" : "s"}, got ${supplied.value.length}`,
    );
  }

  const seed = flags.seed ?? randomUUID().slice(0, 8);
  const rng = supplied.value ? makeFixedRng(supplied.value) : makeRng(seed);
  const result = rollDice(expression, rng);
  if (!result.ok) return result;

  const bounds = diceRange(parsed.value);
  const source = supplied.value ? "supplied dice" : `seed ${seed}`;
  return ok({
    text: `${expression}: ${describeDice(result.value)}\n  (range ${bounds.min}-${bounds.max}, ${source})`,
    json: { expression, total: result.value.total, terms: result.value.terms, seed: supplied.value ? null : seed },
  });
};

const cmdNew: Handler = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (!name) return err("usage: dnd new <name>");
  const seed = flags.seed ?? randomUUID().slice(0, 8);
  const state = createEncounter(name, seed);
  const path = statePath(flags);
  const saved = await saveEncounter(path, state);
  if (!saved.ok) return saved;
  return ok({
    text: `Started "${name}" (seed ${seed})\n  ${path}`,
    json: { name, seed, path },
  });
};

const cmdAdd: Handler = async (positionals, flags) => {
  const ref = positionals[0];
  if (!ref) return err("usage: dnd add <sheet> [--as ID] [--count N]");

  const sheet = await findSheet(ref, SHEET_DIRS);
  if (!sheet.ok) return sheet;

  const countParsed = parseInteger(flags.count ?? "1", "--count");
  if (!countParsed.ok) return countParsed;
  const count = Math.max(1, countParsed.value);
  if (count > 1 && flags.as) return err("--as cannot be combined with --count above 1");

  return withState(flags, (state) => {
    let working = state;
    const added: string[] = [];

    for (let i = 1; i <= count; i++) {
      const baseId = flags.as ?? sheet.value.id;
      const id = count === 1 ? baseId : `${baseId}-${i}`;
      const name = count === 1 ? sheet.value.name : `${sheet.value.name} ${i}`;
      const result = addCombatant(working, { ...sheet.value, id, name });
      if (!result.ok) return result;
      working = result.value;
      added.push(id);
    }

    return ok({
      state: working,
      emission: {
        text: added.map((id) => `Added ${id} (AC ${sheet.value.ac}, ${sheet.value.hp.max} HP)`).join("\n"),
        json: { added },
      },
    });
  });
};

const cmdRemove: Handler = async (positionals, flags) => {
  const id = positionals[0];
  if (!id) return err("usage: dnd remove <id>");
  return withState(flags, (state) => {
    const result = removeCombatant(state, id);
    if (!result.ok) return result;
    return ok({ state: result.value, emission: { text: `Removed ${id}`, json: { removed: id } } });
  });
};

const cmdInit: Handler = async (positionals, flags) => {
  const fixedMap: Record<string, InitiativeOptions> = {};
  for (const entry of flags.fixed ?? []) {
    const [id, value] = entry.split("=");
    if (!id || value === undefined) return err(`--fixed expects id=value, got "${entry}"`);
    const parsed = parseInteger(value, `--fixed ${id}`);
    if (!parsed.ok) return parsed;
    fixedMap[id] = { fixed: parsed.value };
  }

  return withState(flags, (state) => {
    const ids =
      positionals.length > 0
        ? positionals
        : Object.keys(state.combatants);
    if (ids.length === 0) return err("no combatants to roll for — add some first");

    const result = rollInitiativeFor(state, ids, fixedMap);
    if (!result.ok) return result;

    return ok({
      state: result.value.state,
      emission: {
        text: `Initiative:\n${formatInitiative(result.value.state.order)}`,
        json: { order: result.value.state.order },
      },
    });
  });
};

const cmdStart: Handler = async (_positionals, flags) =>
  withState(flags, (state) => {
    const result = startEncounter(state);
    if (!result.ok) return result;
    const first = currentTurn(result.value)!;
    return ok({
      state: result.value,
      emission: {
        text: `Round 1 — ${first.name} acts first\n\n${formatStatus(status(result.value), result.value)}`,
        json: { round: 1, current: first.id },
      },
    });
  });

const cmdNext: Handler = async (_positionals, flags) =>
  withState(flags, (state) => {
    const result = nextTurn(state);
    if (!result.ok) return result;
    const { state: next, entry, newRound } = result.value;
    const banner = newRound ? `── Round ${next.round} ──\n` : "";
    return ok({
      state: next,
      emission: {
        text: `${banner}${entry.name}'s turn${newRound ? "" : ` (round ${next.round})`}`,
        json: { round: next.round, current: entry.id, newRound },
      },
    });
  });

const cmdStatus: Handler = async (_positionals, flags) => {
  const state = await readState(flags);
  if (!state.ok) return state;
  const rows = status(state.value);
  return ok({
    text: formatStatus(rows, state.value),
    json: {
      name: state.value.name, round: state.value.round, started: state.value.started,
      combatants: rows.map((r) => ({
        id: r.combatant.id, name: r.combatant.name, ac: r.combatant.ac,
        hp: r.combatant.hp, speed: r.speed, initiative: r.initiative,
        conditions: r.combatant.conditions, exhaustion: r.combatant.exhaustion,
        concentration: r.combatant.concentration, deathSaves: r.combatant.deathSaves,
        isCurrentTurn: r.isCurrentTurn,
      })),
    },
  });
};

const cmdLog: Handler = async (_positionals, flags) => {
  const state = await readState(flags);
  if (!state.ok) return state;
  const limitParsed = parseInteger(flags.limit ?? "25", "--limit");
  if (!limitParsed.ok) return limitParsed;
  return ok({
    text: formatLog(state.value.log, Math.max(1, limitParsed.value)),
    json: { log: state.value.log.slice(-Math.max(1, limitParsed.value)) },
  });
};

const cmdAttack: Handler = async (positionals, flags) => {
  const [attackerId, targetId] = positionals;
  if (!attackerId || !targetId) {
    return err("usage: dnd attack <attacker> <target> [--weapon NAME | --bonus N --damage EXPR:TYPE]");
  }

  return withState(flags, (state) => {
    const attacker = getCombatant(state, attackerId);
    if (!attacker.ok) return attacker;

    // Resolve the attack from the stat block when named, else from flags.
    let weapon = flags.weapon ?? "attack";
    let bonus: number;
    let damage;
    let melee = !flags.ranged;
    let critRange = 20;
    let weaponRange: number | undefined;
    let weaponLongRange: number | undefined;

    if (flags.weapon) {
      const found = attacker.value.attacks?.find(
        (a) => a.name.toLowerCase() === flags.weapon!.toLowerCase(),
      );
      if (!found) {
        const known = attacker.value.attacks?.map((a) => a.name).join(", ") || "none on this sheet";
        return err(`${attacker.value.name} has no attack "${flags.weapon}" (has: ${known})`);
      }
      weapon = found.name;
      bonus = found.bonus;
      damage = found.damage;
      melee = found.melee !== false && !flags.ranged;
      critRange = found.critRange ?? 20;
      weaponRange = found.range;
      weaponLongRange = found.longRange;
    } else {
      const bonusParsed = parseInteger(flags.bonus, "--bonus (or use --weapon)");
      if (!bonusParsed.ok) return bonusParsed;
      const damageParsed = parseDamageSpecs(flags.damage ?? []);
      if (!damageParsed.ok) return damageParsed;
      if (damageParsed.value.length === 0) {
        return err(`--damage is required, e.g. --damage "1d8+4:slashing"`);
      }
      bonus = bonusParsed.value;
      damage = damageParsed.value;
    }

    if (flags["crit-range"]) {
      const parsed = parseInteger(flags["crit-range"], "--crit-range");
      if (!parsed.ok) return parsed;
      critRange = parsed.value;
    }

    const cover = parseCover(flags.cover);
    if (!cover.ok) return cover;

    const timesParsed = parseInteger(flags.times ?? "1", "--times");
    if (!timesParsed.ok) return timesParsed;

    let distance: number | undefined;
    if (flags.distance !== undefined) {
      const parsed = parseInteger(flags.distance, "--distance");
      if (!parsed.ok) return parsed;
      if (parsed.value < 0) return err("--distance cannot be negative");
      distance = parsed.value;
    }

    const result = performAttacks(state, {
      attackerId, targetId, weapon,
      attackBonus: bonus,
      damage,
      within5: melee,
      ...(distance !== undefined ? { distance } : {}),
      ...(weaponRange !== undefined ? { range: weaponRange } : {}),
      ...(weaponLongRange !== undefined ? { longRange: weaponLongRange } : {}),
      ...(flags.threatened ? { threatened: true } : {}),
      ...(flags.reaction ? { reaction: true } : {}),
      cover: cover.value,
      critRange,
      advantage: flags.adv ?? [],
      disadvantage: flags.dis ?? [],
      force: flags.force ?? false,
    }, timesParsed.value);
    if (!result.ok) return result;

    const { state: next, reports } = result.value;
    return ok({
      state: next,
      emission: {
        text: reports.map((r) => formatAttack(r, next)).join("\n\n"),
        json: reports.length === 1 ? reports[0] : { attacks: reports },
      },
    });
  });
};

const cmdDamage: Handler = async (positionals, flags) => {
  const [targetId, ...amounts] = positionals;
  if (!targetId || amounts.length === 0) {
    return err(`usage: dnd damage <target> <AMOUNT:TYPE>...   e.g. dnd damage goblin 12:fire`);
  }

  const packets: DamagePacket[] = [];
  for (const a of amounts) {
    const parsed = parseFlatDamage(a);
    if (!parsed.ok) return parsed;
    packets.push(parsed.value);
  }

  return withState(flags, (state) => {
    const result = damageCombatant(state, targetId, packets);
    if (!result.ok) return result;
    const { outcome } = result.value;
    const lines = [
      `${state.combatants[targetId]!.name}: ${outcome.hpBefore} → ${outcome.hpAfter} HP (−${outcome.adjustedTotal})`,
      ...outcome.packets
        .filter((p) => p.adjustment !== "normal")
        .map((p) => `  ${p.type} ${p.adjustment}: ${p.before} → ${p.after}`),
      ...outcome.notes.map((n) => `  ! ${n}`),
    ];
    if (result.value.concentration) {
      lines.push(`  concentration: ${result.value.concentration.success ? "holds" : "BROKEN"}`);
    }
    return ok({ state: result.value.state, emission: { text: lines.join("\n"), json: outcome } });
  });
};

const cmdHeal: Handler = async (positionals, flags) => {
  const [targetId, amountText] = positionals;
  if (!targetId || !amountText) return err("usage: dnd heal <target> <amount>");
  const amount = parseInteger(amountText, "amount");
  if (!amount.ok) return amount;

  return withState(flags, (state) => {
    const result = healCombatant(state, targetId, amount.value);
    if (!result.ok) return result;
    const o = result.value.outcome;
    return ok({
      state: result.value.state,
      emission: {
        text: [`${o.combatant.name}: ${o.hpBefore} → ${o.hpAfter} HP (+${o.healed})`, ...o.notes.map((n) => `  ${n}`)].join("\n"),
        json: o,
      },
    });
  });
};

const cmdTempHp: Handler = async (positionals, flags) => {
  const [targetId, amountText] = positionals;
  if (!targetId || !amountText) return err("usage: dnd temphp <target> <amount>");
  const amount = parseInteger(amountText, "amount");
  if (!amount.ok) return amount;
  return withState(flags, (state) => {
    const result = grantTempHp(state, targetId, amount.value);
    if (!result.ok) return result;
    return ok({ state: result.value.state, emission: { text: result.value.note, json: { note: result.value.note } } });
  });
};

const makeCheckCommand = (kind: "save" | "check"): Handler => async (positionals, flags) => {
  const [targetId, abilityText, dcText] = positionals;
  if (!targetId || !abilityText || !dcText) {
    return err(`usage: dnd ${kind} <target> <ability> <dc>`);
  }
  const ability = parseAbility(abilityText);
  if (!ability.ok) return ability;
  const dc = parseInteger(dcText, "dc");
  if (!dc.ok) return dc;

  return withState(flags, (state) => {
    const result = performCheck(state, kind, {
      id: targetId,
      ability: ability.value,
      dc: dc.value,
      ...(flags.proficient ? { proficient: true } : {}),
      ...(flags.expertise ? { expertise: true } : {}),
      advantage: flags.adv ?? [],
      disadvantage: flags.dis ?? [],
    });
    if (!result.ok) return result;
    const name = state.combatants[targetId]!.name;
    return ok({
      state: result.value.state,
      emission: {
        text: formatCheck(result.value.outcome, name, result.value.seed),
        json: { ...result.value.outcome, seed: result.value.seed },
      },
    });
  });
};

const cmdDeathSave: Handler = async (positionals, flags) => {
  const targetId = positionals[0];
  if (!targetId) return err("usage: dnd deathsave <target>");
  return withState(flags, (state) => {
    const result = performDeathSave(state, targetId);
    if (!result.ok) return result;
    const name = state.combatants[targetId]!.name;
    return ok({
      state: result.value.state,
      emission: {
        text: formatDeathSave(result.value.outcome, name, result.value.seed),
        json: { ...result.value.outcome, seed: result.value.seed },
      },
    });
  });
};

const cmdStabilize: Handler = async (positionals, flags) => {
  const targetId = positionals[0];
  if (!targetId) return err("usage: dnd stabilize <target>");
  return withState(flags, (state) => {
    const result = stabiliseCombatant(state, targetId);
    if (!result.ok) return result;
    return ok({
      state: result.value,
      emission: { text: `${state.combatants[targetId]!.name} is stabilised`, json: { stabilised: targetId } },
    });
  });
};

const cmdCondition: Handler = async (positionals, flags) => {
  const [targetId, conditionText] = positionals;
  if (!targetId || !conditionText) {
    return err("usage: dnd condition <target> <name> [--off] [--source ID]");
  }
  const condition = parseCondition(conditionText);
  if (!condition.ok) return condition;

  return withState(flags, (state) => {
    const result = setCondition(state, targetId, condition.value, !flags.off, flags.source);
    if (!result.ok) return result;
    return ok({
      state: result.value.state,
      emission: { text: result.value.note, json: { note: result.value.note, changed: result.value.changed } },
    });
  });
};

const cmdExhaustion: Handler = async (positionals, flags) => {
  const [targetId, levelText] = positionals;
  if (!targetId || levelText === undefined) return err("usage: dnd exhaustion <target> <level>");
  const level = parseInteger(levelText, "level");
  if (!level.ok) return level;

  return withState(flags, (state) => {
    const result = setExhaustion(state, targetId, level.value);
    if (!result.ok) return result;
    const l = result.value.level;
    const text = `${state.combatants[targetId]!.name}: exhaustion ${l} (${-2 * l} to d20 tests, ${-5 * l} ft speed)${result.value.dead ? " — dies at level 6" : ""}`;
    return ok({ state: result.value.state, emission: { text, json: { level: l, dead: result.value.dead } } });
  });
};

const cmdConcentrate: Handler = async (positionals, flags) => {
  const [targetId, ...spellParts] = positionals;
  if (!targetId) return err("usage: dnd concentrate <target> <spell>   |   dnd concentrate <target> --off");
  const spell = flags.off ? null : spellParts.join(" ").trim();
  if (spell !== null && spell === "") return err("name the spell, or pass --off to stop concentrating");

  return withState(flags, (state) => {
    const result = setConcentration(state, targetId, spell);
    if (!result.ok) return result;
    const name = state.combatants[targetId]!.name;
    return ok({
      state: result.value,
      emission: {
        text: spell === null ? `${name} stops concentrating` : `${name} concentrates on ${spell}`,
        json: { concentration: spell },
      },
    });
  });
};

function collectTargets(flags: Flags): string[] {
  const listed = (flags.targets ?? "").split(",").map((t) => t.trim()).filter((t) => t !== "");
  return [...(flags.target ?? []), ...listed];
}

const cmdCast: Handler = async (positionals, flags) => {
  const [casterId, ...nameParts] = positionals;
  const name = nameParts.join(" ").trim();
  if (!casterId || name === "") {
    return err(`usage: dnd cast <caster> <spell> --save dex --damage "8d6:fire" --target goblin-1 [--dc N]`);
  }

  const targetIds = collectTargets(flags);
  if (targetIds.length === 0) return err("name at least one --target (or --targets a,b,c)");

  const ability = parseAbility(flags.save ?? "");
  if (!ability.ok) return err(`--save is required: ${ability.error}`);

  const damage = parseDamageSpecs(flags.damage ?? []);
  if (!damage.ok) return damage;

  const onSuccessRaw = (flags["on-success"] ?? "half").toLowerCase();
  if (onSuccessRaw !== "half" && onSuccessRaw !== "none") {
    return err(`--on-success must be "half" or "none", got "${onSuccessRaw}"`);
  }

  let slotLevel: number | undefined;
  if (flags.slot !== undefined) {
    const parsed = parseInteger(flags.slot, "--slot");
    if (!parsed.ok) return parsed;
    slotLevel = parsed.value;
  }

  return withState(flags, (state) => {
    const caster = getCombatant(state, casterId);
    if (!caster.ok) return caster;

    // Fall back to the caster's own save DC when one is not given.
    let dc: number;
    if (flags.dc !== undefined) {
      const parsed = parseInteger(flags.dc, "--dc");
      if (!parsed.ok) return parsed;
      dc = parsed.value;
    } else {
      const derived = spellSaveDc(caster.value);
      if (derived === null) {
        return err(`${caster.value.name} has no spellcasting ability on their sheet — pass --dc`);
      }
      dc = derived;
    }

    const result = castSpell(state, {
      casterId, name, dc,
      ability: ability.value,
      damage: damage.value,
      onSuccess: onSuccessRaw,
      targetIds,
      ...(slotLevel !== undefined ? { slotLevel } : {}),
      ...(flags.concentrate ? { concentrate: true } : {}),
    });
    if (!result.ok) return result;

    return ok({
      state: result.value.state,
      emission: {
        text: formatCast(result.value.report, caster.value.name),
        json: result.value.report,
      },
    });
  });
};

const cmdSlots: Handler = async (positionals, flags) => {
  const id = positionals[0];
  if (!id) return err("usage: dnd slots <id> [--use N] [--restore N|all]");

  if (flags.use !== undefined) {
    const level = parseInteger(flags.use, "--use");
    if (!level.ok) return level;
    return withState(flags, (state) => {
      const result = useSlot(state, id, level.value);
      if (!result.ok) return result;
      return ok({ state: result.value.state, emission: { text: result.value.note, json: { note: result.value.note } } });
    });
  }

  if (flags.restore !== undefined) {
    const all = flags.restore.toLowerCase() === "all";
    let level: number | null = null;
    if (!all) {
      const parsed = parseInteger(flags.restore, "--restore");
      if (!parsed.ok) return parsed;
      level = parsed.value;
    }
    return withState(flags, (state) => {
      const result = regainSlots(state, id, level);
      if (!result.ok) return result;
      return ok({ state: result.value.state, emission: { text: result.value.note, json: { note: result.value.note } } });
    });
  }

  const state = await readState(flags);
  if (!state.ok) return state;
  const view = spellSlots(state.value, id);
  if (!view.ok) return view;
  const name = state.value.combatants[id]!.name;
  return ok({ text: formatSlots(view.value, name), json: { slots: view.value } });
};

const cmdRest: Handler = async (positionals, flags) => {
  const kind = (positionals[0] ?? "").toLowerCase();
  if (kind !== "short" && kind !== "long") {
    return err("usage: dnd rest short <id> [--hit-dice N]   |   dnd rest long [ids...]");
  }

  if (kind === "short") {
    const id = positionals[1];
    if (!id) return err("usage: dnd rest short <id> [--hit-dice N]");
    const dice = parseInteger(flags["hit-dice"] ?? "0", "--hit-dice");
    if (!dice.ok) return dice;

    return withState(flags, (state) => {
      const result = restShort(state, id, dice.value);
      if (!result.ok) return result;
      const o = result.value.outcome;
      return ok({
        state: result.value.state,
        emission: {
          text: [`${o.combatant.name} short rest: +${o.healed} HP`, ...o.notes.map((n) => `  ${n}`), `  (seed ${result.value.seed})`].join("\n"),
          json: { healed: o.healed, notes: o.notes, seed: result.value.seed },
        },
      });
    });
  }

  return withState(flags, (state) => {
    const ids = positionals.slice(1).length > 0
      ? positionals.slice(1)
      : Object.values(state.combatants).filter((c) => c.isPlayer).map((c) => c.id);
    if (ids.length === 0) return err("no player characters to rest — name ids explicitly");

    const result = restLong(state, ids);
    if (!result.ok) return result;
    const text = result.value.outcomes
      .map(({ outcome }) => [`${outcome.combatant.name} long rest`, ...outcome.notes.map((n) => `  ${n}`)].join("\n"))
      .join("\n");
    return ok({ state: result.value.state, emission: { text, json: { rested: ids } } });
  });
};

const cmdReaction: Handler = async (positionals, flags) => {
  const id = positionals[0];
  if (!id) return err("usage: dnd reaction <id>");
  return withState(flags, (state) => {
    const result = useReaction(state, id);
    if (!result.ok) return result;
    return ok({ state: result.value.state, emission: { text: result.value.note, json: { note: result.value.note } } });
  });
};

const cmdImport: Handler = async (positionals, flags) => {
  const result = await runImport({
    ref: positionals[0],
    from: flags.from,
    outDir: flags.out ?? join(ROOT, "data", "party"),
    rawPath: flags.raw,
    json: flags.json,
    dryRun: flags["dry-run"],
  });
  if (!result.ok) return result;
  return ok({ text: result.value.text, json: result.value.json });
};

const cmdLookup: Handler = async (positionals) => {
  const kind = (positionals[0] ?? "").toLowerCase();
  const queryText = positionals.slice(1).join(" ").trim();
  const kinds: LookupKind[] = ["monster", "spell", "condition"];

  if (!kinds.includes(kind as LookupKind) || queryText === "") {
    return err(`usage: dnd lookup <${kinds.join("|")}> <name>`);
  }

  const result = await lookup(kind as LookupKind, queryText);
  if (!result.ok) return result;
  return ok({
    text: [`${kind} — "${queryText}"`, ...result.value.rows].join("\n"),
    json: { kind, results: result.value.raw },
  });
};

const cmdFetch: Handler = async (positionals, flags) => {
  const name = positionals.join(" ").trim();
  if (name === "") return err(`usage: dnd fetch <monster name> [--as ID] [--dry-run]`);

  const result = await fetchMonster({
    name,
    outDir: flags.out ?? join(ROOT, "data", "monsters"),
    ...(flags.as !== undefined ? { as: flags.as } : {}),
    ...(flags["dry-run"] ? { dryRun: true } : {}),
  });
  if (!result.ok) return result;

  const { imported, writtenTo } = result.value;
  const c = imported.combatant;
  const lines = [
    `${c.name}  —  CR ${imported.challengeRating}, AC ${c.ac}, ${c.hp.max} HP, speed ${c.speed}`,
    `  ${imported.source}`,
  ];
  if (c.attacks && c.attacks.length > 0) {
    const width = Math.max(...c.attacks.map((a) => a.name.length));
    for (const a of c.attacks) {
      const dmg = a.damage.map((d) => `${d.expression} ${d.type}`).join(" + ");
      lines.push(`  ${a.name.padEnd(width)}  ${a.bonus >= 0 ? "+" : ""}${a.bonus} to hit  ${dmg}`);
    }
  }
  if (imported.warnings.length > 0) {
    lines.push("");
    lines.push("  Check these against the stat block:");
    for (const w of imported.warnings) lines.push(`    - ${w}`);
  }
  if (writtenTo !== null) {
    lines.push("");
    lines.push(`  wrote ${writtenTo}`);
  }

  return ok({ text: lines.join("\n"), json: { ...c, writtenTo } });
};

const cmdGen: Handler = async (positionals, flags) => {
  const what = (positionals[0] ?? "").toLowerCase();
  const seed = flags.seed ?? randomUUID().slice(0, 8);
  const rng = makeRng(seed);

  const optionalInt = (raw: string | undefined, label: string): Result<number | undefined, string> => {
    if (raw === undefined) return ok(undefined);
    const parsed = parseInteger(raw, label);
    return parsed.ok ? ok(parsed.value) : parsed;
  };

  switch (what) {
    case "merchant":
    case "shop": {
      const lines = optionalInt(flags.lines, "--lines");
      if (!lines.ok) return lines;
      const made = generateMerchant(rng, {
        ...(flags.kind !== undefined ? { kind: flags.kind } : {}),
        ...(lines.value !== undefined ? { stockLines: lines.value } : {}),
      });
      if (!made.ok) return made;
      return ok({ text: formatMerchant(made.value, seed), json: { ...made.value, seed } });
    }

    case "town":
    case "settlement": {
      if (flags.size !== undefined && !settlementSizes().includes(flags.size)) {
        return err(`unknown size "${flags.size}"; expected one of ${settlementSizes().join(", ")}`);
      }
      const shops = optionalInt(flags.shops, "--shops");
      if (!shops.ok) return shops;
      const made = generateSettlement(rng, {
        ...(flags.size !== undefined ? { size: flags.size } : {}),
        ...(shops.value !== undefined ? { shops: shops.value } : {}),
      });
      return ok({ text: formatSettlement(made, seed), json: { ...made, seed } });
    }

    case "wilderness":
    case "map": {
      const width = optionalInt(flags.width, "--width");
      if (!width.ok) return width;
      const height = optionalInt(flags.height, "--height");
      if (!height.ok) return height;
      const scale = optionalInt(flags.scale, "--scale");
      if (!scale.ok) return scale;

      const options: WildernessOptions = {
        ...(width.value !== undefined ? { width: width.value } : {}),
        ...(height.value !== undefined ? { height: height.value } : {}),
        ...(scale.value !== undefined ? { scaleMiles: scale.value } : {}),
        ...(flags.terrain !== undefined ? { dominant: flags.terrain as WildernessOptions["dominant"] } : {}),
      };
      const made = generateWilderness(rng, options);
      if (!made.ok) return made;
      return ok({ text: formatWilderness(made.value, seed), json: { ...made.value, seed } });
    }

    default:
      return err(
        `usage: dnd gen <merchant|town|wilderness> [--seed S]\n` +
          `  merchant   --kind <${shopKinds().join("|")}> [--lines N]\n` +
          `  town       --size <${settlementSizes().join("|")}> [--shops N]\n` +
          `  wilderness --width N --height N [--terrain <${terrainNames().join("|")}>] [--scale MILES]`,
      );
  }
};

const cmdSheets: Handler = async () => {
  const lines: string[] = [];
  const all: { id: string; path: string }[] = [];
  for (const dir of SHEET_DIRS) {
    const listing = await listSheets(dir);
    if (!listing.ok) return listing;
    if (listing.value.length === 0) continue;
    lines.push(`${dir.replace(ROOT + "/", "")}:`);
    for (const e of listing.value) {
      lines.push(`  ${e.id}`);
      all.push(e);
    }
  }
  return ok({
    text: lines.length > 0 ? lines.join("\n") : "No stat blocks found under data/.",
    json: { sheets: all },
  });
};

const cmdEncounters: Handler = async () => {
  const listing = await listEncounters(ENCOUNTER_DIR);
  if (!listing.ok) return listing;
  return ok({
    text: listing.value.length > 0 ? listing.value.map((n) => `  ${n}`).join("\n") : "No saved encounters.",
    json: { encounters: listing.value },
  });
};

const COMMANDS: Record<string, Handler> = {
  roll: cmdRoll,
  new: cmdNew,
  add: cmdAdd,
  remove: cmdRemove,
  init: cmdInit,
  start: cmdStart,
  next: cmdNext,
  status: cmdStatus,
  log: cmdLog,
  attack: cmdAttack,
  damage: cmdDamage,
  heal: cmdHeal,
  temphp: cmdTempHp,
  save: makeCheckCommand("save"),
  check: makeCheckCommand("check"),
  deathsave: cmdDeathSave,
  stabilize: cmdStabilize,
  stabilise: cmdStabilize,
  condition: cmdCondition,
  exhaustion: cmdExhaustion,
  concentrate: cmdConcentrate,
  cast: cmdCast,
  slots: cmdSlots,
  rest: cmdRest,
  reaction: cmdReaction,
  gen: cmdGen,
  lookup: cmdLookup,
  fetch: cmdFetch,
  import: cmdImport,
  sheets: cmdSheets,
  encounters: cmdEncounters,
};

async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (cause) {
    process.stderr.write(`error: ${(cause as Error).message}\n`);
    return 1;
  }

  const flags = parsed.values as unknown as Flags;
  const [command, ...positionals] = parsed.positionals;

  if (!command || flags.help) {
    process.stdout.write(HELP);
    return command ? 0 : 1;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    const known = Object.keys(COMMANDS).sort().join(", ");
    process.stderr.write(`error: unknown command "${command}"\n  known commands: ${known}\n`);
    return 1;
  }

  let result: Result<Emission, string>;
  try {
    result = await handler(positionals, flags);
  } catch (cause) {
    if (cause instanceof FixedRngExhausted) {
      process.stderr.write(`error: ${cause.message} — supply more values to --dice\n`);
      return 1;
    }
    throw cause;
  }

  if (!result.ok) {
    if (flags.json) process.stdout.write(JSON.stringify({ ok: false, error: result.error }) + "\n");
    else process.stderr.write(`error: ${result.error}\n`);
    return 1;
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, ...(result.value.json as object) }, null, 2) + "\n");
  } else {
    process.stdout.write(result.value.text + "\n");
  }
  return 0;
}

const code = await main(process.argv.slice(2));
process.exit(code);
