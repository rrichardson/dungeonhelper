/**
 * Campaign wiki access.
 *
 * The campaign lives in a folder of Markdown notes inside an OpenKnowledge
 * project, shared live between the DM and the assistant. Reading and writing
 * notes goes through OpenKnowledge itself; this module only locates the
 * campaign and reads a note from disk for the engine to import. Every note
 * convention lives in the campaign skill, and stat block parsing is pure.
 *
 * Paths are platform paths: the campaign may sit on a Windows drive as easily
 * as under a Unix home. Note paths are reported with forward slashes, which is
 * how OpenKnowledge addresses documents on every platform.
 */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, basename, extname, relative, dirname, resolve, sep } from "node:path";
import { type Result, ok, err } from "../engine/result.ts";

export interface WikiConfig {
  readonly wiki: string;
}

/** The environment variables this module reads, passed in by the caller. */
export type Env = Readonly<Record<string, string | undefined>>;

export interface Note {
  /** Path relative to the campaign folder, e.g. "Monsters/Sporeblight Goose.md". */
  readonly path: string;
  /** Filename without extension — how links refer to it. */
  readonly title: string;
  /** Folder within the campaign, or "" for notes at its root. */
  readonly folder: string;
}

const CONFIG_FILE = "campaign.json";

/** Folders the tools and the OS keep that are not campaign content. */
const IGNORED = new Set([".ok", ".obsidian", ".trash", ".git", "node_modules"]);

/** Forward slashes, whatever the platform separator. */
function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Turn what the DM typed into an absolute path. A leading `~` is expanded
 * here because not every shell does it — PowerShell passes it through.
 */
export function expandPath(input: string, cwd: string, home: string): string {
  const trimmed = input.trim();
  const expanded = /^~(?=$|[\\/])/.test(trimmed) ? join(home, trimmed.slice(1)) : trimmed;
  return resolve(cwd, expanded);
}

/**
 * Locate the campaign folder: DND_WIKI in the environment wins, then
 * campaign.json at the repo root. The older "vault" key and DND_VAULT are
 * still honoured so an existing setup keeps working.
 */
export async function resolveWiki(root: string, env: Env): Promise<Result<string, string>> {
  const fromEnv = [env["DND_WIKI"], env["DND_VAULT"]].find((v) => v !== undefined && v.trim() !== "");
  if (fromEnv !== undefined) return verifyWiki(fromEnv.trim());

  const configPath = join(root, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return err(
      `no campaign wiki configured — run "dnd wiki set <path to campaign folder>", or set DND_WIKI`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return err(`${CONFIG_FILE} is not valid JSON: ${(cause as Error).message}`);
  }
  const config = parsed as Partial<WikiConfig> & { vault?: unknown };
  const wiki = config.wiki ?? config.vault;
  if (typeof wiki !== "string" || wiki.trim() === "") {
    return err(`${CONFIG_FILE} has no "wiki" path`);
  }
  return verifyWiki(wiki);
}

async function verifyWiki(path: string): Promise<Result<string, string>> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return err(`${path} is not a directory`);
    return ok(path);
  } catch {
    return err(`campaign wiki not found at ${path} — run "dnd wiki set <path>" to point at it`);
  }
}

/** Record the campaign folder in campaign.json, as an absolute path. */
export async function setWiki(root: string, wikiPath: string): Promise<Result<string, string>> {
  const verified = await verifyWiki(wikiPath);
  if (!verified.ok) return verified;
  try {
    await writeFile(
      join(root, CONFIG_FILE),
      `${JSON.stringify({ wiki: verified.value }, null, 2)}\n`,
      "utf8",
    );
  } catch (cause) {
    return err(`could not write ${CONFIG_FILE}: ${(cause as Error).message}`);
  }
  return ok(verified.value);
}

export interface Project {
  /** The OpenKnowledge project root: the nearest folder holding `.ok/`. */
  readonly root: string;
  /** The campaign folder relative to that root, with forward slashes; "" if it is the root. */
  readonly campaign: string;
}

/**
 * Find the OpenKnowledge project that contains the campaign folder, walking
 * up from it. Undefined when there is none — the folder has not been set up
 * with `ok init` yet.
 *
 * A project is marked by `.ok/config.yml`, not by `.ok/` alone: OpenKnowledge
 * keeps its user-wide settings in `~/.ok`, and folders inside a project carry
 * their own `.ok/` for templates. Neither is a project root.
 */
export async function findProject(wiki: string): Promise<Project | undefined> {
  let dir = resolve(wiki);
  for (;;) {
    try {
      if ((await stat(join(dir, ".ok", "config.yml"))).isFile()) {
        return { root: dir, campaign: toPosix(relative(dir, resolve(wiki))) };
      }
    } catch {
      // No .ok here; keep climbing.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Every Markdown note in the campaign, recursively. */
export async function listNotes(wiki: string): Promise<Result<Note[], string>> {
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
      } else if ([".md", ".mdx"].includes(extname(entry.name))) {
        const rel = toPosix(relative(wiki, full));
        const folder = dirname(rel) === "." ? "" : dirname(rel);
        out.push({ path: rel, title: basename(entry.name, extname(entry.name)), folder });
      }
    }
    return ok(undefined);
  };

  const walked = await walk(wiki);
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
export async function findNote(wiki: string, ref: string): Promise<Result<LoadedNote, string>> {
  const notes = await listNotes(wiki);
  if (!notes.ok) return notes;

  const wanted = ref.trim().toLowerCase();
  const exact = notes.value.filter((n) => n.title.toLowerCase() === wanted);
  const chosen = exact.length > 0
    ? exact
    : notes.value.filter((n) => n.title.toLowerCase().includes(wanted));

  if (chosen.length === 0) return err(`no note titled "${ref}" in the campaign wiki`);
  if (chosen.length > 1) {
    const names = chosen.slice(0, 8).map((n) => n.path).join(", ");
    return err(`"${ref}" matches several notes: ${names} — name one exactly`);
  }

  const note = chosen[0]!;
  try {
    const content = await readFile(join(wiki, ...note.path.split("/")), "utf8");
    return ok({ ...note, content });
  } catch (cause) {
    return err(`cannot read ${note.path}: ${(cause as Error).message}`);
  }
}
