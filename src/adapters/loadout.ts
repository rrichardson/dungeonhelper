/**
 * Loadouts: which homebrew items a party member carries and is attuned to.
 *
 * A loadout lives beside the character's sheet as
 * data/party/<id>.loadout.json, separate from the D&D Beyond import so a
 * re-import never wipes it:
 *
 *   { "items": [
 *       { "note": "Voidfang Katars", "attuned": true },
 *       { "note": "Fungicide Blade", "attuned": true, "as-attack": "flame tongue greatsword" }
 *   ] }
 *
 * "note" names the wiki note holding the item's effects block. "as-attack"
 * says which attack on the sheet the weapon takes over. "name" picks one
 * definition when a note holds several.
 *
 * Definitions are read from the wiki every time, so the wiki stays the source
 * of truth: edit the note and the next `dnd add` picks the change up.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Result, ok, err } from "../engine/result.ts";
import type { Combatant } from "../engine/types.ts";
import { parseNoteDefs } from "../engine/homebrew/note.ts";
import { attach, type AttachRequest } from "../engine/homebrew/equip.ts";
import { findNote } from "./wiki.ts";

export interface LoadoutItem {
  readonly note: string;
  readonly attuned: boolean;
  readonly asAttack?: string;
  readonly name?: string;
}

export function loadoutPath(partyDir: string, id: string): string {
  return join(partyDir, `${id}.loadout.json`);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseLoadout(json: unknown, where: string): Result<LoadoutItem[], string> {
  if (!isObj(json) || !Array.isArray(json["items"])) return err(`${where}: expected {"items": [...]}`);
  const out: LoadoutItem[] = [];
  for (const [i, item] of json["items"].entries()) {
    const at = `${where}: items[${i}]`;
    if (!isObj(item) || typeof item["note"] !== "string" || item["note"].trim() === "") {
      return err(`${at}: expected {"note": "<wiki note>", "attuned": true}`);
    }
    if (item["attuned"] !== undefined && typeof item["attuned"] !== "boolean") return err(`${at}.attuned: expected true or false`);
    out.push({
      note: item["note"],
      attuned: item["attuned"] === true,
      ...(typeof item["as-attack"] === "string" ? { asAttack: item["as-attack"] } : {}),
      ...(typeof item["name"] === "string" ? { name: item["name"] } : {}),
    });
  }
  return ok(out);
}

export function serialiseLoadout(items: readonly LoadoutItem[]): string {
  return `${JSON.stringify({
    items: items.map((i) => ({
      note: i.note,
      attuned: i.attuned,
      ...(i.asAttack !== undefined ? { "as-attack": i.asAttack } : {}),
      ...(i.name !== undefined ? { name: i.name } : {}),
    })),
  }, null, 2)}\n`;
}

/** A missing loadout file is an empty loadout, not an error. */
export async function readLoadout(path: string): Promise<Result<LoadoutItem[], string>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return ok([]);
  }
  try {
    return parseLoadout(JSON.parse(text), path);
  } catch (cause) {
    return err(`${path} is not valid JSON: ${(cause as Error).message}`);
  }
}

export async function writeLoadout(path: string, items: readonly LoadoutItem[]): Promise<Result<string, string>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serialiseLoadout(items), "utf8");
    return ok(path);
  } catch (cause) {
    return err(`cannot write ${path}: ${(cause as Error).message}`);
  }
}

/** Read a note's definitions and pick the one an item (or request) means. */
export async function definitionFromNote(
  wiki: string,
  noteRef: string,
  name?: string,
): Promise<Result<{ request: Omit<AttachRequest, "attuned" | "origin">; path: string }, string>> {
  const note = await findNote(wiki, noteRef);
  if (!note.ok) return note;
  const defs = parseNoteDefs(note.value.content, note.value.path);
  if (!defs.ok) return defs;
  if (defs.value.length === 0) return err(`${note.value.path} has no \`\`\`effects block`);
  let chosen = defs.value[0]!;
  if (defs.value.length > 1) {
    const match = name === undefined ? undefined : defs.value.find((d) => d.def.name.toLowerCase() === name.toLowerCase());
    if (match === undefined) {
      return err(`${note.value.path} defines ${defs.value.map((d) => d.def.name).join(", ")} — name one`);
    }
    chosen = match;
  }
  return ok({ request: { def: chosen.def, source: chosen.source, note: note.value.path }, path: note.value.path });
}

/** Attach every item in a loadout to a freshly loaded sheet. */
export async function applyLoadout(
  c: Combatant,
  items: readonly LoadoutItem[],
  wiki: string,
): Promise<Result<{ combatant: Combatant; lines: string[] }, string>> {
  let working = c;
  const lines: string[] = [];
  for (const item of items) {
    const found = await definitionFromNote(wiki, item.note, item.name);
    if (!found.ok) return err(`loadout of ${c.name}: ${found.error}`);
    const attached = attach(working, {
      ...found.value.request,
      attuned: item.attuned,
      origin: "loadout",
      ...(item.asAttack !== undefined ? { asAttack: item.asAttack } : {}),
    });
    if (!attached.ok) return err(`loadout of ${c.name}: ${attached.error}`);
    working = attached.value;
    const def = found.value.request.def;
    lines.push(`  ${def.name}${def.attunement ? (item.attuned ? " (attuned)" : " (NOT attuned — inactive)") : ""}`);
  }
  return ok({ combatant: working, lines });
}
