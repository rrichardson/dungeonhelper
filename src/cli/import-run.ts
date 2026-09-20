/**
 * The import workflow, shared by `dnd import` and the standalone script.
 *
 * Edge code: it fetches, reads and writes. The derivation it wraps is pure.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Result, ok, err } from "../engine/result.ts";
import { fetchDdbCharacter, parseCharacterId, type FetchLike } from "../adapters/ddb.ts";
import { normalizeDdb, type Ruleset } from "../engine/import/ddb.ts";
import { formatImportReport } from "../engine/import/ddb-report.ts";

export interface ImportOptions {
  /** A character id or URL, or a local payload file when `from` is set. */
  readonly ref?: string;
  readonly from?: string;
  readonly outDir: string;
  readonly rawPath?: string;
  readonly json?: boolean;
  readonly dryRun?: boolean;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: FetchLike;
}

export interface ImportOutcome {
  readonly text: string;
  readonly json: unknown;
  readonly ruleset: Ruleset;
  readonly writtenTo: string | null;
  readonly warnings: readonly string[];
}

async function loadPayload(options: ImportOptions): Promise<Result<unknown, string>> {
  if (options.from !== undefined) {
    let text: string;
    try {
      text = await readFile(options.from, "utf8");
    } catch (cause) {
      return err(`could not read ${options.from}: ${(cause as Error).message}`);
    }
    try {
      return ok(JSON.parse(text));
    } catch (cause) {
      return err(`${options.from} is not valid JSON: ${(cause as Error).message}`);
    }
  }

  if (options.ref === undefined || options.ref.trim() === "") {
    return err("give a D&D Beyond character id or URL, or --from <file>");
  }
  const id = parseCharacterId(options.ref);
  if (!id.ok) return id;

  return fetchDdbCharacter(id.value, {
    fetch: options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
  });
}

export async function runImport(options: ImportOptions): Promise<Result<ImportOutcome, string>> {
  const payload = await loadPayload(options);
  if (!payload.ok) return payload;

  if (options.rawPath !== undefined) {
    try {
      await mkdir(dirname(options.rawPath), { recursive: true });
      await writeFile(options.rawPath, `${JSON.stringify(payload.value, null, 1)}\n`, "utf8");
    } catch (cause) {
      return err(`could not save raw payload: ${(cause as Error).message}`);
    }
  }

  const normalized = normalizeDdb(payload.value);
  if (!normalized.ok) return normalized;

  const { combatant, meta, warnings } = normalized.value;
  const sheet = { ...combatant, meta };

  let writtenTo: string | null = null;
  if (options.dryRun !== true) {
    const path = join(options.outDir, `${combatant.id}.json`);
    try {
      await mkdir(options.outDir, { recursive: true });
      await writeFile(path, `${JSON.stringify(sheet, null, 2)}\n`, "utf8");
    } catch (cause) {
      return err(`could not write ${path}: ${(cause as Error).message}`);
    }
    writtenTo = path;
  }

  const report = formatImportReport(normalized.value);
  const text = writtenTo === null ? report : `${report}\n\nwrote ${writtenTo}`;

  return ok({
    text: options.json === true ? JSON.stringify(sheet, null, 2) : text,
    json: sheet,
    ruleset: meta.ruleset,
    writtenTo,
    warnings,
  });
}
