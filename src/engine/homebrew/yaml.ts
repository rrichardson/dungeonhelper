/**
 * A strict, documented subset of YAML — enough to author homebrew effects by
 * hand in a wiki note, and no more. Pure and total: malformed input returns
 * an error naming the line, never an exception.
 *
 * Supported:
 *   - block mappings          key: value
 *   - block sequences         - value          (items may be mappings)
 *   - nested blocks by indentation (spaces only; tabs are refused)
 *   - flow collections        [a, b]  {key: value, other: [1, 2]}
 *   - scalars: integers and decimals (a leading + is allowed: +3),
 *     true / false, null / ~, "double" or 'single' quoted strings,
 *     and plain strings
 *   - literal (|) and folded (>) block strings
 *   - comments: a line starting with #, or " #" after a value
 *
 * Not supported (refused or read as plain text): anchors, aliases, tags,
 * multi-document streams, complex keys.
 */

import { type Result, ok, err } from "../result.ts";

export type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  readonly n: number;      // 1-based source line number
  readonly indent: number;
  readonly text: string;   // content after indentation, comment stripped
}

const KEY = /^([A-Za-z0-9_][A-Za-z0-9_ -]*?)\s*:(?:\s+(.*))?$/;

/** Remove a trailing " # comment" that is not inside quotes. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function scalar(raw: string, n: number): Result<YamlValue, string> {
  const t = raw.trim();
  if (t === "") return ok(null);
  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) return err(`line ${n}: unterminated "string"`);
    try {
      return ok(JSON.parse(t) as string);
    } catch {
      return err(`line ${n}: bad escape in ${t}`);
    }
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) return err(`line ${n}: unterminated 'string'`);
    return ok(t.slice(1, -1).replace(/''/g, "'"));
  }
  if (t === "true") return ok(true);
  if (t === "false") return ok(false);
  if (t === "null" || t === "~") return ok(null);
  if (/^[+-]?\d+(\.\d+)?$/.test(t)) return ok(Number(t));
  if (t.startsWith("&") || t.startsWith("*") || t.startsWith("!")) {
    return err(`line ${n}: anchors, aliases and tags are not supported ("${t}")`);
  }
  return ok(t);
}

/** Parse a flow collection or scalar starting at text[pos]. */
function flow(text: string, n: number): Result<YamlValue, string> {
  let pos = 0;

  const ws = () => { while (pos < text.length && /\s/.test(text[pos]!)) pos++; };

  const value = (): Result<YamlValue, string> => {
    ws();
    const ch = text[pos];
    if (ch === "[") {
      pos++;
      const out: YamlValue[] = [];
      ws();
      if (text[pos] === "]") { pos++; return ok(out); }
      for (;;) {
        const v = value();
        if (!v.ok) return v;
        out.push(v.value);
        ws();
        if (text[pos] === ",") { pos++; continue; }
        if (text[pos] === "]") { pos++; return ok(out); }
        return err(`line ${n}: expected "," or "]" in flow list`);
      }
    }
    if (ch === "{") {
      pos++;
      const out: Record<string, YamlValue> = {};
      ws();
      if (text[pos] === "}") { pos++; return ok(out); }
      for (;;) {
        ws();
        const keyStart = pos;
        while (pos < text.length && text[pos] !== ":" && text[pos] !== "," && text[pos] !== "}") pos++;
        let key = text.slice(keyStart, pos).trim();
        if (/^(".*"|'.*')$/.test(key)) key = key.slice(1, -1);
        if (text[pos] !== ":" || key === "") return err(`line ${n}: expected "key: value" in flow map`);
        if (Object.hasOwn(out, key)) return err(`line ${n}: duplicate key "${key}"`);
        pos++;
        const v = value();
        if (!v.ok) return v;
        out[key] = v.value;
        ws();
        if (text[pos] === ",") { pos++; continue; }
        if (text[pos] === "}") { pos++; return ok(out); }
        return err(`line ${n}: expected "," or "}" in flow map`);
      }
    }
    // A scalar runs to the next flow delimiter, unless quoted.
    const start = pos;
    if (ch === '"' || ch === "'") {
      pos++;
      while (pos < text.length && text[pos] !== ch) {
        if (text[pos] === "\\" && ch === '"') pos++;
        pos++;
      }
      pos++;
      return scalar(text.slice(start, pos), n);
    }
    while (pos < text.length && !",]}".includes(text[pos]!)) pos++;
    return scalar(text.slice(start, pos), n);
  };

  const v = value();
  if (!v.ok) return v;
  ws();
  if (pos < text.length) return err(`line ${n}: unexpected "${text.slice(pos)}" after value`);
  return v;
}

function inline(text: string, n: number): Result<YamlValue, string> {
  const t = text.trim();
  if (t.startsWith("[") || t.startsWith("{")) return flow(t, n);
  return scalar(t, n);
}

interface Cursor { i: number }

function blockString(lines: readonly Line[], cur: Cursor, parentIndent: number, folded: boolean, raw: readonly string[]): string {
  const collected: string[] = [];
  let minIndent = Infinity;
  const start = cur.i;
  while (cur.i < lines.length && lines[cur.i]!.indent > parentIndent) {
    minIndent = Math.min(minIndent, lines[cur.i]!.indent);
    cur.i++;
  }
  for (let k = start; k < cur.i; k++) {
    collected.push(raw[lines[k]!.n - 1]!.slice(minIndent).trimEnd());
  }
  return folded ? collected.join(" ") : collected.join("\n");
}

function block(lines: readonly Line[], cur: Cursor, indent: number, raw: readonly string[]): Result<YamlValue, string> {
  const first = lines[cur.i]!;
  const isSeq = first.text === "-" || first.text.startsWith("- ");
  return isSeq ? sequence(lines, cur, indent, raw) : mapping(lines, cur, indent, raw);
}

function childValue(
  lines: readonly Line[], cur: Cursor, indent: number, rest: string, n: number, raw: readonly string[],
): Result<YamlValue, string> {
  if (rest === "|" || rest === ">") return ok(blockString(lines, cur, indent, rest === ">", raw));
  if (rest !== "") return inline(rest, n);
  const next = lines[cur.i];
  if (next === undefined) return ok(null);
  if (next.indent > indent) return block(lines, cur, next.indent, raw);
  // "key:" followed by a sequence at the same indentation is valid YAML.
  if (next.indent === indent && (next.text === "-" || next.text.startsWith("- "))) {
    return sequence(lines, cur, indent, raw);
  }
  return ok(null);
}

function mapping(lines: readonly Line[], cur: Cursor, indent: number, raw: readonly string[]): Result<YamlValue, string> {
  const out: Record<string, YamlValue> = {};
  while (cur.i < lines.length) {
    const line = lines[cur.i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) return err(`line ${line.n}: unexpected indentation`);
    if (line.text.startsWith("- ") || line.text === "-") break;
    const m = KEY.exec(line.text);
    if (!m) return err(`line ${line.n}: expected "key: value", got "${line.text}"`);
    const key = m[1]!.trim();
    if (Object.hasOwn(out, key)) return err(`line ${line.n}: duplicate key "${key}"`);
    cur.i++;
    const v = childValue(lines, cur, indent, (m[2] ?? "").trim(), line.n, raw);
    if (!v.ok) return v;
    out[key] = v.value;
  }
  return ok(out);
}

function sequence(lines: readonly Line[], cur: Cursor, indent: number, raw: readonly string[]): Result<YamlValue, string> {
  const out: YamlValue[] = [];
  const mutable = lines as Line[];
  while (cur.i < lines.length) {
    const line = lines[cur.i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) return err(`line ${line.n}: unexpected indentation`);
    if (!(line.text === "-" || line.text.startsWith("- "))) break;
    const content = line.text === "-" ? "" : line.text.slice(2).trimStart();
    const itemIndent = indent + (line.text.length - content.length);

    if (content === "") {
      cur.i++;
      const next = lines[cur.i];
      if (next === undefined || next.indent <= indent) { out.push(null); continue; }
      const v = block(lines, cur, next.indent, raw);
      if (!v.ok) return v;
      out.push(v.value);
      continue;
    }

    const looksLikeKey = !content.startsWith("[") && !content.startsWith("{")
      && !content.startsWith('"') && !content.startsWith("'") && KEY.test(content);
    if (looksLikeKey) {
      // Re-read "- key: v" as a mapping whose first line sits at the item's column.
      mutable[cur.i] = { n: line.n, indent: itemIndent, text: content };
      const v = mapping(lines, cur, itemIndent, raw);
      if (!v.ok) return v;
      out.push(v.value);
      continue;
    }

    cur.i++;
    const v = inline(content, line.n);
    if (!v.ok) return v;
    out.push(v.value);
  }
  return ok(out);
}

export function parseYaml(text: string): Result<YamlValue, string> {
  const raw = text.split(/\r?\n/);
  const lines: Line[] = [];
  for (let i = 0; i < raw.length; i++) {
    const full = raw[i]!;
    const lead = /^[ \t]*/.exec(full)![0];
    if (lead.includes("\t")) return err(`line ${i + 1}: tabs are not allowed for indentation; use spaces`);
    const body = full.slice(lead.length);
    if (body === "" || body.startsWith("#")) continue;
    const textPart = stripComment(body);
    if (textPart === "") continue;
    lines.push({ n: i + 1, indent: lead.length, text: textPart });
  }
  if (lines.length === 0) return ok(null);
  const cur: Cursor = { i: 0 };
  const first = lines[0]!;
  const v = block(lines, cur, first.indent, raw);
  if (!v.ok) return v;
  if (cur.i < lines.length) {
    return err(`line ${lines[cur.i]!.n}: unexpected content "${lines[cur.i]!.text}" (check indentation)`);
  }
  return v;
}
