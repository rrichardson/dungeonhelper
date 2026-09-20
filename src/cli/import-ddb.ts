#!/usr/bin/env node
/**
 * Standalone entry point for character import, kept for direct invocation.
 * `dnd import` runs the same code through the main CLI.
 */

import { parseArgs } from "node:util";
import { runImport } from "./import-run.ts";

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

const result = await runImport({
  ref: positionals[0],
  from: values.from,
  outDir: values.out!,
  rawPath: values.raw,
  json: values.json,
  dryRun: values["dry-run"],
});

if (!result.ok) {
  process.stderr.write(`error: ${result.error}\n`);
  process.exit(1);
}

process.stdout.write(`${result.value.text}\n`);

// A 2014 sheet in a 2024 engine is a correctness problem, not a note.
if (result.value.ruleset === "2014") process.exitCode = 2;
