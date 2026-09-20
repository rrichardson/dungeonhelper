/**
 * Dice notation: parsing and evaluation.
 *
 * Grammar (whitespace insensitive, case insensitive):
 *   expression := term (('+' | '-') term)*
 *   term       := dice | integer
 *   dice       := [count] 'd' sides [keep]
 *   keep       := ('kh' | 'kl' | 'dh' | 'dl') [n]      -- n defaults to 1
 *
 * Examples: "1d20", "2d6+3", "4d6kh3", "1d8+1d6+2", "2d20kl1-1"
 *
 * Parsing is total: bad input returns an error value, never an exception.
 */

import { type Result, ok, err } from "./result.ts";
import type { Rng } from "./rng.ts";

export type KeepMode = "kh" | "kl" | "dh" | "dl";

export interface DiceSpec {
  readonly count: number;
  readonly sides: number;
  readonly keep?: { readonly mode: KeepMode; readonly n: number };
}

export interface ParsedTerm {
  readonly sign: 1 | -1;
  readonly notation: string;
  readonly dice?: DiceSpec;
  readonly constant?: number;
}

export interface ParsedDice {
  readonly expression: string;
  readonly terms: readonly ParsedTerm[];
}

export interface DieRoll {
  readonly sides: number;
  readonly value: number;
  /** False when dropped by a kh/kl/dh/dl modifier. Dropped dice are still shown. */
  readonly kept: boolean;
}

export interface RolledTerm {
  readonly notation: string;
  readonly sign: 1 | -1;
  readonly rolls: readonly DieRoll[];
  /** Signed contribution of this term to the total. */
  readonly total: number;
}

export interface DiceResult {
  readonly expression: string;
  readonly terms: readonly RolledTerm[];
  readonly total: number;
}

const MAX_DICE = 1000;
const MAX_SIDES = 1000;

const DICE_RE = /^(\d*)d(\d+)((?:(?:kh|kl|dh|dl)\d*)?)$/;
const KEEP_RE = /^(kh|kl|dh|dl)(\d*)$/;

function parseTerm(raw: string, sign: 1 | -1): Result<ParsedTerm, string> {
  const text = raw.trim().toLowerCase();
  if (text === "") return err("empty term in dice expression");

  if (/^\d+$/.test(text)) {
    return ok({ sign, notation: text, constant: Number(text) });
  }

  const m = DICE_RE.exec(text);
  if (!m) return err(`cannot parse "${raw}" as dice or a number`);

  const count = m[1] === "" ? 1 : Number(m[1]);
  const sides = Number(m[2]);
  if (count < 1) return err(`die count must be at least 1 in "${raw}"`);
  if (count > MAX_DICE) return err(`die count ${count} exceeds limit of ${MAX_DICE}`);
  if (sides < 1) return err(`a die needs at least 1 side in "${raw}"`);
  if (sides > MAX_SIDES) return err(`die size d${sides} exceeds limit of d${MAX_SIDES}`);

  const keepRaw = m[3] ?? "";
  if (keepRaw === "") return ok({ sign, notation: text, dice: { count, sides } });

  const km = KEEP_RE.exec(keepRaw);
  if (!km) return err(`cannot parse modifier "${keepRaw}" in "${raw}"`);
  const mode = km[1] as KeepMode;
  const n = km[2] === "" ? 1 : Number(km[2]);
  if (n < 1) return err(`"${mode}" needs a positive count in "${raw}"`);
  if (n > count) {
    return err(`"${mode}${n}" asks for ${n} of only ${count} dice in "${raw}"`);
  }
  return ok({ sign, notation: text, dice: { count, sides, keep: { mode, n } } });
}

/** Parse a dice expression. Returns an error value for malformed input. */
export function parseDice(expression: string): Result<ParsedDice, string> {
  const text = expression.replace(/\s+/g, "");
  if (text === "") return err("dice expression is empty");
  if (!/^[0-9d+\-khl]+$/i.test(text)) {
    return err(`dice expression "${expression}" contains unsupported characters`);
  }

  const terms: ParsedTerm[] = [];
  let sign: 1 | -1 = 1;
  let buffer = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "+" || ch === "-") {
      if (buffer === "" && terms.length === 0 && ch === "-") {
        return err("dice expression cannot start with a negative term");
      }
      if (buffer === "") return err(`stray "${ch}" in "${expression}"`);
      const term = parseTerm(buffer, sign);
      if (!term.ok) return term;
      terms.push(term.value);
      buffer = "";
      sign = ch === "+" ? 1 : -1;
    } else {
      buffer += ch;
    }
  }
  if (buffer === "") return err(`dice expression "${expression}" ends with an operator`);
  const term = parseTerm(buffer, sign);
  if (!term.ok) return term;
  terms.push(term.value);

  return ok({ expression: text, terms });
}

/** Mark which dice survive a keep/drop modifier, preserving roll order. */
function applyKeep(values: readonly number[], keep: DiceSpec["keep"]): DieRoll[] {
  if (!keep) return values.map((v) => ({ sides: 0, value: v, kept: true }));

  const indexed = values.map((value, index) => ({ value, index }));
  const ascending = [...indexed].sort((a, b) => a.value - b.value || a.index - b.index);

  let keptIndices: Set<number>;
  switch (keep.mode) {
    case "kh":
      keptIndices = new Set(ascending.slice(values.length - keep.n).map((d) => d.index));
      break;
    case "kl":
      keptIndices = new Set(ascending.slice(0, keep.n).map((d) => d.index));
      break;
    case "dh":
      keptIndices = new Set(ascending.slice(0, values.length - keep.n).map((d) => d.index));
      break;
    case "dl":
      keptIndices = new Set(ascending.slice(keep.n).map((d) => d.index));
      break;
  }
  return values.map((value, index) => ({ sides: 0, value, kept: keptIndices.has(index) }));
}

/** Evaluate a parsed expression. Pure with respect to the supplied Rng. */
export function rollParsed(parsed: ParsedDice, rng: Rng): DiceResult {
  const terms: RolledTerm[] = [];
  let total = 0;

  for (const term of parsed.terms) {
    if (term.constant !== undefined) {
      const signed = term.sign * term.constant;
      total += signed;
      terms.push({ notation: term.notation, sign: term.sign, rolls: [], total: signed });
      continue;
    }
    const spec = term.dice!;
    const raw: number[] = [];
    for (let i = 0; i < spec.count; i++) raw.push(rng.int(1, spec.sides));

    const rolls = applyKeep(raw, spec.keep).map((r) => ({ ...r, sides: spec.sides }));
    const sum = rolls.reduce((acc, r) => (r.kept ? acc + r.value : acc), 0);
    const signed = term.sign * sum;
    total += signed;
    terms.push({ notation: term.notation, sign: term.sign, rolls, total: signed });
  }

  return { expression: parsed.expression, terms, total };
}

/** Parse and evaluate in one step. */
export function roll(expression: string, rng: Rng): Result<DiceResult, string> {
  const parsed = parseDice(expression);
  if (!parsed.ok) return parsed;
  return ok(rollParsed(parsed.value, rng));
}

/** How many individual dice an expression will consume — used to validate physical rolls. */
export function diceCount(parsed: ParsedDice): number {
  return parsed.terms.reduce((n, t) => n + (t.dice?.count ?? 0), 0);
}

/** Minimum and maximum possible totals, for sanity checks and display. */
export function range(parsed: ParsedDice): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const term of parsed.terms) {
    if (term.constant !== undefined) {
      min += term.sign * term.constant;
      max += term.sign * term.constant;
      continue;
    }
    const spec = term.dice!;
    const kept = spec.keep
      ? spec.keep.mode === "kh" || spec.keep.mode === "kl"
        ? spec.keep.n
        : spec.count - spec.keep.n
      : spec.count;
    const lo = kept * 1;
    const hi = kept * spec.sides;
    if (term.sign === 1) {
      min += lo;
      max += hi;
    } else {
      min -= hi;
      max -= lo;
    }
  }
  return { min, max };
}

/**
 * Double the dice of an expression while leaving flat modifiers alone — the
 * 2024 critical hit rule ("roll the damage dice twice, add modifiers once").
 * "2d6+3" becomes "4d6+3"; keep/drop modifiers scale with the die count.
 */
export function doubleDice(parsed: ParsedDice): ParsedDice {
  const terms = parsed.terms.map((term): ParsedTerm => {
    if (!term.dice) return term;
    const { count, sides, keep } = term.dice;
    const doubled: DiceSpec = keep
      ? { count: count * 2, sides, keep: { mode: keep.mode, n: keep.n * 2 } }
      : { count: count * 2, sides };
    const keepText = doubled.keep ? `${doubled.keep.mode}${doubled.keep.n}` : "";
    return {
      sign: term.sign,
      notation: `${doubled.count}d${sides}${keepText}`,
      dice: doubled,
    };
  });
  const expression = terms
    .map((t, i) => (i === 0 ? t.notation : `${t.sign === 1 ? "+" : "-"}${t.notation}`))
    .join("");
  return { expression, terms };
}
