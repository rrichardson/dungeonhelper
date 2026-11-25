/**
 * The homebrew formula language: small, deterministic arithmetic over a
 * creature's numbers. Parsed by hand — never evaluated as JavaScript.
 *
 *   formula := term (('+' | '-') term)*
 *   term    := factor (('*' | '/') factor)*          -- '/' divides and rounds down
 *   factor  := integer | name | name '(' arg ')' | '(' formula ')' | '-' factor
 *   name    := prof | level | level(<class>) | mod(<ability>)
 *
 *   prof            proficiency bonus
 *   level           total character level
 *   level(fighter)  levels in one class (0 when the creature has none in it)
 *   mod(con)        an ability modifier
 *
 * Examples: "level(fighter) + mod(con)", "prof * 2", "8 + prof + mod(cha)",
 * "level / 2".
 *
 * Dice are not part of formulas. Damage expressions use dice notation and may
 * contain the same names, which are replaced by their values before rolling
 * (see substituteNames).
 */

import { type Result, ok, err } from "../result.ts";
import { ABILITIES, abilityModifier, type Ability, type Combatant } from "../types.ts";

export type Formula =
  | { readonly op: "num"; readonly value: number }
  | { readonly op: "prof" }
  | { readonly op: "level"; readonly cls?: string }
  | { readonly op: "mod"; readonly ability: Ability }
  | { readonly op: "neg"; readonly a: Formula }
  | { readonly op: "+" | "-" | "*" | "/"; readonly a: Formula; readonly b: Formula };

export interface FormulaContext {
  readonly prof: number;
  readonly level: number | undefined;
  readonly classLevels: Readonly<Record<string, number>> | undefined;
  readonly mods: Readonly<Record<Ability, number>>;
}

export function contextOf(c: Combatant): FormulaContext {
  const mods = {} as Record<Ability, number>;
  for (const a of ABILITIES) mods[a] = abilityModifier(c.abilities[a]);
  const classLevels = c.classLevels;
  const level = c.level ?? (classLevels ? Object.values(classLevels).reduce((s, n) => s + n, 0) : undefined);
  return { prof: c.proficiencyBonus, level, classLevels, mods };
}

type Token = { kind: "num"; value: number } | { kind: "name"; value: string } | { kind: "sym"; value: string };

function tokenize(text: string): Result<Token[], string> {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (/\d/.test(ch)) {
      let j = i;
      while (j < text.length && /\d/.test(text[j]!)) j++;
      out.push({ kind: "num", value: Number(text.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[a-z_]/i.test(ch)) {
      let j = i;
      while (j < text.length && /[a-z_-]/i.test(text[j]!)) j++;
      out.push({ kind: "name", value: text.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ("+-*/()".includes(ch)) {
      out.push({ kind: "sym", value: ch });
      i++;
      continue;
    }
    return err(`unexpected "${ch}" in formula "${text}"`);
  }
  return ok(out);
}

export function parseFormula(source: string | number): Result<Formula, string> {
  if (typeof source === "number") {
    if (!Number.isInteger(source)) return err(`formula must be a whole number, got ${source}`);
    return ok({ op: "num", value: source });
  }
  const text = source.trim();
  if (text === "") return err("empty formula");
  if (/\d+d\d+/i.test(text)) return err(`formula "${text}" contains dice; formulas are fixed numbers`);
  const tokens = tokenize(text);
  if (!tokens.ok) return tokens;
  const ts = tokens.value;
  let pos = 0;

  const peek = () => ts[pos];
  const isSym = (v: string) => { const t = peek(); return t?.kind === "sym" && t.value === v; };

  const factor = (): Result<Formula, string> => {
    const t = peek();
    if (t === undefined) return err(`formula "${text}" ends unexpectedly`);
    if (t.kind === "num") { pos++; return ok({ op: "num", value: t.value }); }
    if (t.kind === "sym" && t.value === "-") {
      pos++;
      const a = factor();
      if (!a.ok) return a;
      return ok({ op: "neg", a: a.value });
    }
    if (t.kind === "sym" && t.value === "(") {
      pos++;
      const inner = expr();
      if (!inner.ok) return inner;
      if (!isSym(")")) return err(`formula "${text}": missing ")"`);
      pos++;
      return inner;
    }
    if (t.kind === "name") {
      pos++;
      let arg: string | undefined;
      if (isSym("(")) {
        pos++;
        const a = peek();
        if (a?.kind !== "name") return err(`formula "${text}": ${t.value}(...) needs a name inside`);
        arg = a.value;
        pos++;
        if (!isSym(")")) return err(`formula "${text}": missing ")"`);
        pos++;
      }
      if (t.value === "prof" && arg === undefined) return ok({ op: "prof" });
      if (t.value === "level") return ok(arg === undefined ? { op: "level" } : { op: "level", cls: arg });
      if (t.value === "mod") {
        if (arg === undefined || !ABILITIES.includes(arg as Ability)) {
          return err(`formula "${text}": mod() needs one of ${ABILITIES.join(", ")}`);
        }
        return ok({ op: "mod", ability: arg as Ability });
      }
      return err(`formula "${text}": unknown name "${t.value}" (use prof, level, level(class), mod(ability))`);
    }
    return err(`formula "${text}": unexpected "${t.value}"`);
  };

  const term = (): Result<Formula, string> => {
    let left = factor();
    if (!left.ok) return left;
    while (isSym("*") || isSym("/")) {
      const op = (peek() as { value: "*" | "/" }).value;
      pos++;
      const right = factor();
      if (!right.ok) return right;
      left = ok({ op, a: (left as { value: Formula }).value, b: right.value });
    }
    return left;
  };

  const expr = (): Result<Formula, string> => {
    let left = term();
    if (!left.ok) return left;
    while (isSym("+") || isSym("-")) {
      const op = (peek() as { value: "+" | "-" }).value;
      pos++;
      const right = term();
      if (!right.ok) return right;
      left = ok({ op, a: (left as { value: Formula }).value, b: right.value });
    }
    return left;
  };

  const result = expr();
  if (!result.ok) return result;
  if (pos < ts.length) return err(`formula "${text}": unexpected "${String(ts[pos]!.value)}"`);
  return result;
}

export function evalFormula(f: Formula, ctx: FormulaContext): Result<number, string> {
  switch (f.op) {
    case "num": return ok(f.value);
    case "prof": return ok(ctx.prof);
    case "mod": return ok(ctx.mods[f.ability]);
    case "level": {
      if (f.cls === undefined) {
        if (ctx.level === undefined) return err("formula uses level, but this creature has no level recorded");
        return ok(ctx.level);
      }
      if (ctx.classLevels === undefined) {
        return err(`formula uses level(${f.cls}), but this creature has no class levels recorded`);
      }
      return ok(ctx.classLevels[f.cls] ?? 0);
    }
    case "neg": {
      const a = evalFormula(f.a, ctx);
      return a.ok ? ok(-a.value) : a;
    }
    default: {
      const a = evalFormula(f.a, ctx);
      if (!a.ok) return a;
      const b = evalFormula(f.b, ctx);
      if (!b.ok) return b;
      switch (f.op) {
        case "+": return ok(a.value + b.value);
        case "-": return ok(a.value - b.value);
        case "*": return ok(a.value * b.value);
        case "/":
          if (b.value === 0) return err("formula divides by zero");
          return ok(Math.floor(a.value / b.value));
      }
    }
  }
}

/** Render a formula back to text, for logs. */
export function showFormula(f: Formula): string {
  switch (f.op) {
    case "num": return String(f.value);
    case "prof": return "prof";
    case "mod": return `mod(${f.ability})`;
    case "level": return f.cls === undefined ? "level" : `level(${f.cls})`;
    case "neg": return `-${showFormula(f.a)}`;
    default: return `${showFormula(f.a)} ${f.op} ${showFormula(f.b)}`;
  }
}

const NAME_IN_DICE = /\b(prof|level\([a-z_-]+\)|level|mod\([a-z]+\))/gi;

/** Names a dice expression refers to, so they can be validated at authoring time. */
export function namesInDice(expression: string): string[] {
  return [...expression.matchAll(NAME_IN_DICE)].map((m) => m[1]!);
}

/**
 * Replace formula names in a dice expression with their values, so
 * "1d8 + mod(str)" becomes "1d8+3". Signs are normalised so a negative
 * modifier reads "1d8-1" rather than "1d8+-1".
 */
export function substituteNames(expression: string, ctx: FormulaContext): Result<string, string> {
  let failure: string | null = null;
  const replaced = expression.replace(NAME_IN_DICE, (name) => {
    const parsed = parseFormula(name);
    if (!parsed.ok) { failure = parsed.error; return "0"; }
    const value = evalFormula(parsed.value, ctx);
    if (!value.ok) { failure = value.error; return "0"; }
    return String(value.value);
  });
  if (failure !== null) return err(failure);
  return ok(replaced.replace(/\s+/g, "").replace(/\+-/g, "-").replace(/--/g, "+"));
}
