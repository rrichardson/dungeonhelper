#!/usr/bin/env node
/**
 * Import a character from D&D Beyond into data/party/.
 *
 *   node src/cli/import-ddb.ts https://www.dndbeyond.com/characters/167935384
 *   node src/cli/import-ddb.ts 167935384 --json
 *   node src/cli/import-ddb.ts 167935384 --raw test/fixtures/ddb/167935384.json
 *   node src/cli/import-ddb.ts --from test/fixtures/ddb/167935384.json
 *
 * Standalone so it can be wired into the main `dnd` CLI as a subcommand later.
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchDdbCharacter, parseCharacterId } from "../adapters/ddb.ts";
import { normalizeDdb } from "../engine/import/ddb.ts";
import { formatImportReport } from "../engine/import/ddb-report.ts";

const USAGE = `
Import a D&D Beyond character.

  import-ddb <id|url>           fetch from D&D Beyond
  import-ddb --from <file>      import a saved payload instead of fetching

Options
  --out <dir>    where to write the character  (default: data/party)
  --raw <file>   also save the untouched payload, for use as a test fixture
  --json         print the normalized character as JSON instead of a report
  --dry-run      print the report, write nothing

The character's privacy must be set to Public on D&D Beyond.
`.trim();

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    from: { type: "string" },
    out: { type: "string", default: "data/party" },
    raw: { type: "string" },
    json: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || (positionals.length === 0 && values.from === undefined)) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(values.help ? 0 : 1);
}

async function loadPayload(): Promise<unknown> {
  if (values.from !== undefined) {
    try {
      return JSON.parse(readFileSync(values.from, "utf8"));
    } catch (cause) {
      fail(`could not read ${values.from}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  const id = parseCharacterId(positionals[0]!);
  if (!id.ok) fail(id.error);

  const fetched = await fetchDdbCharacter(id.value, { fetch: globalThis.fetch as never });
  if (!fetched.ok) fail(fetched.error);
  return fetched.value;
}

const payload = await loadPayload();

if (values.raw !== undefined) {
  mkdirSync(dirname(values.raw), { recursive: true });
  writeFileSync(values.raw, `${JSON.stringify(payload, null, 1)}\n`);
  process.stderr.write(`saved raw payload to ${values.raw}\n`);
}

const result = normalizeDdb(payload);
if (!result.ok) fail(result.error);

const { combatant, meta, warnings } = result.value;

if (values.json) {
  process.stdout.write(`${JSON.stringify({ ...combatant, meta }, null, 2)}\n`);
} else {
  process.stdout.write(`${formatImportReport(result.value)}\n`);
}

if (!values["dry-run"]) {
  const path = join(values.out!, `${combatant.id}.json`);
  mkdirSync(values.out!, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...combatant, meta }, null, 2)}\n`);
  if (!values.json) process.stdout.write(`\nwrote ${path}\n`);
}

// A 2014 sheet in a 2024 engine is a correctness problem, not a note.
if (meta.ruleset === "2014") process.exitCode = 2;
void warnings;
