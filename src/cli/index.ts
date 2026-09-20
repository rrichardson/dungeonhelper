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
  setConcentration, status, getCombatant, type EncounterState,
} from "../engine/encounter.ts";
import { loadEncounter, saveEncounter, encounterPath, listEncounters } from "../adapters/store.ts";
import { findSheet, listSheets } from "../adapters/sheets.ts";
import {
  describeDice, formatAttack, formatCheck, formatDeathSave, formatInitiative,
  formatStatus, formatLog,
} from "../adapters/format.ts";
import {
  parseDamageSpecs, parseFlatDamage, parseAbility, parseCondition, parseCover,
  parseInteger, parseSuppliedDice,
} from "./args.ts";
import type { DamagePacket } from "../engine/damage.ts";
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
         [--adv REASON] [--dis REASON] [--cover half|three-quarters|total]
         [--ranged] [--crit-range N] [--force]
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

    const result = performAttack(state, {
      attackerId, targetId, weapon,
      attackBonus: bonus,
      damage,
      within5: melee,
      cover: cover.value,
      critRange,
      advantage: flags.adv ?? [],
      disadvantage: flags.dis ?? [],
      force: flags.force ?? false,
    });
    if (!result.ok) return result;

    return ok({
      state: result.value.state,
      emission: {
        text: formatAttack(result.value.report, result.value.state),
        json: result.value.report,
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
