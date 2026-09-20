/** SRD lookup and monster import. Edge code: network and file writes. */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Result, ok, err } from "../engine/result.ts";
import type { FetchLike } from "../adapters/ddb.ts";
import {
  findCreature, searchCreatures, searchSpells, searchConditions, DOCUMENT_2024,
  type Open5eDeps,
} from "../adapters/open5e.ts";
import { normalizeCreature, type Open5eImport } from "../engine/import/open5e.ts";

function deps(fetchImpl?: FetchLike): Open5eDeps {
  return { fetch: fetchImpl ?? (globalThis.fetch as unknown as FetchLike) };
}

export interface FetchMonsterOptions {
  readonly name: string;
  readonly outDir: string;
  readonly as?: string;
  readonly dryRun?: boolean;
  readonly fetchImpl?: FetchLike;
}

export interface FetchMonsterOutcome {
  readonly imported: Open5eImport;
  readonly writtenTo: string | null;
}

export async function fetchMonster(
  options: FetchMonsterOptions,
): Promise<Result<FetchMonsterOutcome, string>> {
  const found = await findCreature(options.name, deps(options.fetchImpl));
  if (!found.ok) return found;

  const normalized = normalizeCreature(found.value);
  if (!normalized.ok) return normalized;

  const combatant = options.as
    ? { ...normalized.value.combatant, id: options.as }
    : normalized.value.combatant;

  if (options.dryRun === true) {
    return ok({ imported: { ...normalized.value, combatant }, writtenTo: null });
  }

  const path = join(options.outDir, `${combatant.id}.json`);
  try {
    await mkdir(options.outDir, { recursive: true });
    await writeFile(path, `${JSON.stringify(combatant, null, 2)}\n`, "utf8");
  } catch (cause) {
    return err(`could not write ${path}: ${(cause as Error).message}`);
  }
  return ok({ imported: { ...normalized.value, combatant }, writtenTo: path });
}

export type LookupKind = "monster" | "spell" | "condition";

export interface LookupOutcome {
  readonly kind: LookupKind;
  readonly rows: readonly string[];
  readonly raw: readonly unknown[];
}

function text(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "string" ? child : undefined;
}

function nested(value: unknown, key: string, inner: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const child = (value as Record<string, unknown>)[key];
  return text(child, inner);
}

function number(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "number" ? child : undefined;
}

/** Trim a long rules paragraph down to something readable in a terminal. */
function shorten(value: string | undefined, max = 220): string {
  if (value === undefined) return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

export async function lookup(
  kind: LookupKind,
  queryText: string,
  fetchImpl?: FetchLike,
): Promise<Result<LookupOutcome, string>> {
  const d = deps(fetchImpl);

  if (kind === "monster") {
    const found = await searchCreatures(queryText, d);
    if (!found.ok) return found;
    if (found.value.length === 0) return err(`no creature matching "${queryText}"`);
    return ok({
      kind,
      raw: found.value,
      rows: found.value.map((c) => {
        const name = text(c, "name") ?? "?";
        const cr = number(c, "challenge_rating");
        const ac = number(c, "armor_class");
        const hp = number(c, "hit_points");
        const type = nested(c, "type", "name") ?? "";
        return `  ${name}  —  CR ${cr ?? "?"}, AC ${ac ?? "?"}, ${hp ?? "?"} HP${type ? `, ${type}` : ""}`;
      }),
    });
  }

  if (kind === "spell") {
    const found = await searchSpells(queryText, d);
    if (!found.ok) return found;
    if (found.value.length === 0) return err(`no spell matching "${queryText}"`);
    return ok({
      kind,
      raw: found.value,
      rows: found.value.flatMap((s) => {
        const name = text(s, "name") ?? "?";
        const level = number(s, "level");
        const school = nested(s, "school", "name") ?? "";
        const head = `  ${name}  —  level ${level ?? "?"}${school ? ` ${school}` : ""}`;
        const body = shorten(text(s, "desc"));
        return body ? [head, `      ${body}`] : [head];
      }),
    });
  }

  const found = await searchConditions(queryText, d);
  if (!found.ok) return found;
  if (found.value.length === 0) return err(`no condition matching "${queryText}"`);
  return ok({
    kind,
    raw: found.value,
    rows: found.value.flatMap((c) => [
      `  ${text(c, "name") ?? "?"}`,
      `      ${shorten(conditionText(c), 400)}`,
    ]),
  });
}

/**
 * A condition carries one description per source document. Prefer the 2024
 * SRD, since that is the ruleset the engine implements, and fall back to
 * whatever is offered rather than showing nothing.
 */
function conditionText(condition: unknown): string | undefined {
  if (typeof condition !== "object" || condition === null) return undefined;
  const entries = (condition as { descriptions?: unknown }).descriptions;
  if (!Array.isArray(entries)) return text(condition, "desc");

  const preferred = entries.find((e) => text(e, "document") === DOCUMENT_2024);
  return text(preferred ?? entries[0], "desc");
}
