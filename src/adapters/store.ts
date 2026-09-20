/**
 * Encounter persistence. The only module that touches encounter files.
 *
 * State is stored as plain JSON so the DM can read it, hand-edit it mid-session
 * when something unusual happens, and diff it in git to see what a round did.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, basename, extname, dirname } from "node:path";
import { type Result, ok, err } from "../engine/result.ts";
import { parseCombatant } from "./sheets.ts";
import type { EncounterState } from "../engine/encounter.ts";
import type { Combatant } from "../engine/types.ts";

export const STATE_VERSION = 1;

interface StoredEncounter {
  readonly version: number;
  readonly state: EncounterState;
}

export function encounterPath(dir: string, name = "current"): string {
  return join(dir, `${name}.json`);
}

export async function saveEncounter(
  path: string,
  state: EncounterState,
): Promise<Result<string, string>> {
  const payload: StoredEncounter = { version: STATE_VERSION, state };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
    return ok(path);
  } catch (cause) {
    return err(`cannot write ${path}: ${(cause as Error).message}`);
  }
}

/**
 * Read an encounter back. Combatants are re-validated on load so a hand-edited
 * file fails loudly here rather than producing wrong arithmetic later.
 */
export async function loadEncounter(path: string): Promise<Result<EncounterState, string>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return err(`no encounter at ${path} — run "dnd new <name>" to start one`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return err(`${path} is not valid JSON: ${(cause as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    return err(`${path}: expected an object`);
  }
  const stored = parsed as Partial<StoredEncounter>;
  if (stored.version !== STATE_VERSION) {
    return err(
      `${path}: unsupported state version ${String(stored.version)} (this build reads version ${STATE_VERSION})`,
    );
  }
  const state = stored.state;
  if (!state || typeof state !== "object") return err(`${path}: missing "state"`);

  const combatants: Record<string, Combatant> = {};
  for (const [id, raw] of Object.entries(state.combatants ?? {})) {
    const validated = parseCombatant(raw, `${basename(path)}: combatants.${id}`);
    if (!validated.ok) return validated;
    // parseCombatant resets volatile fields; restore the live ones from disk.
    const live = raw as Combatant;
    combatants[id] = {
      ...validated.value,
      conditions: live.conditions ?? [],
      concentration: live.concentration ?? null,
      deathSaves: live.deathSaves ?? { successes: 0, failures: 0 },
      stable: live.stable ?? false,
      exhaustion: live.exhaustion ?? 0,
    };
  }

  return ok({ ...state, combatants } as EncounterState);
}

export async function listEncounters(dir: string): Promise<Result<string[], string>> {
  try {
    const names = await readdir(dir);
    return ok(names.filter((n) => extname(n) === ".json").map((n) => basename(n, ".json")).sort());
  } catch {
    return ok([]);
  }
}
