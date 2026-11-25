/**
 * Reading homebrew definitions out of a wiki note.
 *
 * A note carries its mechanics in one or more fenced blocks tagged `effects`,
 * written in the YAML subset described in yaml.ts. The prose around the block
 * is for people; the block is for the engine. One block holds one definition.
 *
 * Pure: takes the note's text, returns definitions or the first error.
 */

import { type Result, ok, err } from "../result.ts";
import { parseYaml } from "./yaml.ts";
import { validateDef } from "./schema.ts";
import type { HomebrewDef } from "./types.ts";

export interface EffectsBlock {
  /** 1-based line of the opening fence, for error messages. */
  readonly line: number;
  readonly text: string;
}

const FENCE = /^(`{3,}|~{3,})[ \t]*effects[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gm;

export function extractEffectsBlocks(markdown: string): EffectsBlock[] {
  const out: EffectsBlock[] = [];
  for (const m of markdown.matchAll(FENCE)) {
    const line = markdown.slice(0, m.index).split(/\r?\n/).length;
    out.push({ line, text: m[2]! });
  }
  return out;
}

export interface ParsedDef {
  readonly def: HomebrewDef;
  readonly source: unknown;
}

/** Every definition in a note. A note with no effects block yields none. */
export function parseNoteDefs(markdown: string, where: string): Result<ParsedDef[], string> {
  const out: ParsedDef[] = [];
  for (const block of extractEffectsBlocks(markdown)) {
    const label = `${where} (effects block at line ${block.line})`;
    const yaml = parseYaml(block.text);
    if (!yaml.ok) return err(`${label}: ${yaml.error}`);
    const def = validateDef(yaml.value, label);
    if (!def.ok) return def;
    out.push({ def: def.value, source: yaml.value });
  }
  return ok(out);
}
