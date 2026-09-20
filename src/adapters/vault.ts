/**
 * Campaign wiki access.
 *
 * The vault is an Obsidian-style folder of Markdown notes shared between the
 * DM and the assistant. This module only reads and writes files; every note
 * convention lives in the campaign skill, and stat block parsing is pure.
 */

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { join, basename, extname, relative, dirname } from "node:path";
import { type Result, ok, err } from "../engine/result.ts";

export interface VaultConfig {
  readonly vault: string;
}

export interface Note {
  /** Path relative to the vault root, e.g. "Monsters/Sporeblight Goose.md". */
  readonly path: string;
  /** Filename without extension — how wikilinks refer to it. */
  readonly title: string;
  /** Top-level folder, or "" for notes at the root. */
  readonly folder: string;
}

const CONFIG_FILE = "campaign.json";

/** Folders Obsidian and the OS keep that are not campaign content. */
const IGNORED = new Set([".obsidian", ".trash", ".git", "node_modules"]);

/**
 * Locate the active vault: the DND_VAULT environment variable wins, then
 * campaign.json at the repo root.
 */
export async function resolveVault(root: string): Promise<Result<string, string>> {
  const fromEnv = process.env["DND_VAULT"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return verifyVault(fromEnv.trim());

  const configPath = join(root, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return err(
      `no campaign vault configured — run "dnd vault set <path to vault>", or set DND_VAULT`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return err(`${CONFIG_FILE} is not valid JSON: ${(cause as Error).message}`);
  }
  const vault = (parsed as Partial<VaultConfig>).vault;
  if (typeof vault !== "string" || vault.trim() === "") {
    return err(`${CONFIG_FILE} has no "vault" path`);
  }
  return verifyVault(vault);
}

async function verifyVault(path: string): Promise<Result<string, string>> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return err(`${path} is not a directory`);
    return ok(path);
  } catch {
    return err(`vault not found at ${path}`);
  }
}

export async function setVault(root: string, vaultPath: string): Promise<Result<string, string>> {
  const verified = await verifyVault(vaultPath);
  if (!verified.ok) return verified;
  try {
    await writeFile(
      join(root, CONFIG_FILE),
      `${JSON.stringify({ vault: verified.value }, null, 2)}\n`,
      "utf8",
    );
  } catch (cause) {
    return err(`could not write ${CONFIG_FILE}: ${(cause as Error).message}`);
  }
  return ok(verified.value);
}

/** Every Markdown note in the vault, recursively. */
export async function listNotes(vault: string): Promise<Result<Note[], string>> {
  const out: Note[] = [];

  const walk = async (dir: string): Promise<Result<void, string>> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (cause) {
      return err(`cannot read ${dir}: ${(cause as Error).message}`);
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await walk(full);
        if (!nested.ok) return nested;
      } else if (extname(entry.name) === ".md") {
        const rel = relative(vault, full);
        const folder = dirname(rel) === "." ? "" : dirname(rel);
        out.push({ path: rel, title: basename(entry.name, ".md"), folder });
      }
    }
    return ok(undefined);
  };

  const walked = await walk(vault);
  if (!walked.ok) return walked;
  out.sort((a, b) => a.path.localeCompare(b.path));
  return ok(out);
}

export interface LoadedNote extends Note {
  readonly content: string;
}

/**
 * Find a note by title. An exact title match wins; otherwise a unique
 * case-insensitive substring match is accepted, and an ambiguous one is
 * refused with the candidates named.
 */
export async function findNote(vault: string, ref: string): Promise<Result<LoadedNote, string>> {
  const notes = await listNotes(vault);
  if (!notes.ok) return notes;

  const wanted = ref.trim().toLowerCase();
  const exact = notes.value.filter((n) => n.title.toLowerCase() === wanted);
  const chosen = exact.length > 0
    ? exact
    : notes.value.filter((n) => n.title.toLowerCase().includes(wanted));

  if (chosen.length === 0) return err(`no note titled "${ref}" in the vault`);
  if (chosen.length > 1) {
    const names = chosen.slice(0, 8).map((n) => n.title).join(", ");
    return err(`"${ref}" matches several notes: ${names} — name one exactly`);
  }

  const note = chosen[0]!;
  try {
    const content = await readFile(join(vault, note.path), "utf8");
    return ok({ ...note, content });
  } catch (cause) {
    return err(`cannot read ${note.path}: ${(cause as Error).message}`);
  }
}

export interface SearchHit {
  readonly note: Note;
  readonly line: number;
  readonly text: string;
}

/** Case-insensitive substring search across every note body and title. */
export async function searchVault(
  vault: string,
  needle: string,
  limit = 40,
): Promise<Result<SearchHit[], string>> {
  const notes = await listNotes(vault);
  if (!notes.ok) return notes;

  const wanted = needle.trim().toLowerCase();
  if (wanted === "") return err("give some text to search for");

  const hits: SearchHit[] = [];
  for (const note of notes.value) {
    if (hits.length >= limit) break;
    let content: string;
    try {
      content = await readFile(join(vault, note.path), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (lines[i]!.toLowerCase().includes(wanted)) {
        hits.push({ note, line: i + 1, text: lines[i]!.trim() });
      }
    }
  }
  return ok(hits);
}

/**
 * Write a note. Refuses to overwrite existing content unless told to: the DM
 * writes in this vault too, and their work is not ours to replace.
 */
export async function writeNote(
  vault: string,
  relPath: string,
  content: string,
  overwrite = false,
): Promise<Result<string, string>> {
  const full = join(vault, relPath.endsWith(".md") ? relPath : `${relPath}.md`);

  if (!overwrite) {
    try {
      await stat(full);
      return err(`${relPath} already exists — pass overwrite to replace it`);
    } catch {
      // Absent, which is what we want.
    }
  }

  try {
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  } catch (cause) {
    return err(`could not write ${relPath}: ${(cause as Error).message}`);
  }
  return ok(full);
}

/** Wikilinks referenced by a note, in order of first appearance. */
export function wikilinks(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const target = m[1]!.trim();
    if (target !== "" && !out.includes(target)) out.push(target);
  }
  return out;
}
