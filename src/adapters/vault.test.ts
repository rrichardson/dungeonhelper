import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listNotes, findNote, searchVault, writeNote, wikilinks, resolveVault, setVault,
} from "./vault.ts";

async function makeVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dnd-vault-"));
  await mkdir(join(dir, "Monsters"), { recursive: true });
  await mkdir(join(dir, "NPCs"), { recursive: true });
  await mkdir(join(dir, ".obsidian"), { recursive: true });
  await mkdir(join(dir, "Rooms", "Zone 1"), { recursive: true });

  await writeFile(join(dir, "CAMPAIGN.md"), "# Campaign\n\nThe party enters [[Aintport]].\n");
  await writeFile(join(dir, "Monsters", "Cellar Hound.md"), "# Cellar Hound\n\nA fungal beast. See [[Elemental Fonts]].\n");
  await writeFile(join(dir, "NPCs", "Bram Kelter.md"), "# Bram Kelter\n\nGroundskeeper, knows about the fissure.\n");
  await writeFile(join(dir, "Rooms", "Zone 1", "The Fissure.md"), "# The Fissure\n\nA chasm.\n");
  await writeFile(join(dir, ".obsidian", "workspace.json"), "{}");
  await writeFile(join(dir, "Monsters", "notes.txt"), "not a note");
  return dir;
}

test("every Markdown note is listed, and nothing else", async () => {
  const vault = await makeVault();
  const notes = await listNotes(vault);
  assert.ok(notes.ok);
  const paths = notes.value.map((n) => n.path);

  assert.equal(notes.value.length, 4);
  assert.ok(paths.some((p) => p.endsWith("Cellar Hound.md")));
  assert.ok(!paths.some((p) => p.includes(".obsidian")), "Obsidian's own files are not content");
  assert.ok(!paths.some((p) => p.endsWith(".txt")));
});

test("notes record their folder and title", async () => {
  const vault = await makeVault();
  const notes = await listNotes(vault);
  assert.ok(notes.ok);

  const room = notes.value.find((n) => n.title === "The Fissure")!;
  assert.equal(room.folder, join("Rooms", "Zone 1"));

  const campaign = notes.value.find((n) => n.title === "CAMPAIGN")!;
  assert.equal(campaign.folder, "", "root notes have no folder");
});

test("a note is found by exact title, case-insensitively", async () => {
  const vault = await makeVault();
  const found = await findNote(vault, "cellar hound");
  assert.ok(found.ok);
  assert.equal(found.value.title, "Cellar Hound");
  assert.match(found.value.content, /fungal beast/);
});

test("a unique partial title is accepted", async () => {
  const vault = await makeVault();
  const found = await findNote(vault, "Bram");
  assert.ok(found.ok);
  assert.equal(found.value.title, "Bram Kelter");
});

test("an ambiguous title is refused with the candidates named", async () => {
  const vault = await makeVault();
  await writeFile(join(vault, "Monsters", "Cellar Hound Alpha.md"), "# Cellar Hound Alpha\n");
  const found = await findNote(vault, "Cellar Hound A");
  assert.ok(found.ok, "a unique partial still resolves");

  const ambiguous = await findNote(vault, "Cellar");
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.ok ? "" : ambiguous.error, /matches several notes/);
});

test("an exact title wins over a longer partial match", async () => {
  const vault = await makeVault();
  await writeFile(join(vault, "Monsters", "Cellar Hound Alpha.md"), "# Cellar Hound Alpha\n");
  const found = await findNote(vault, "Cellar Hound");
  assert.ok(found.ok, "the exact title should resolve despite the longer sibling");
  assert.equal(found.value.title, "Cellar Hound");
});

test("a missing note is reported plainly", async () => {
  const vault = await makeVault();
  const found = await findNote(vault, "Nonexistent");
  assert.equal(found.ok, false);
  assert.match(found.ok ? "" : found.error, /no note titled/);
});

test("search finds text with its note and line number", async () => {
  const vault = await makeVault();
  const hits = await searchVault(vault, "fissure");
  assert.ok(hits.ok);
  assert.ok(hits.value.length >= 1);
  assert.ok(hits.value.some((h) => h.note.title === "Bram Kelter"));
  assert.ok(hits.value.every((h) => h.line >= 1));
});

test("search is case-insensitive and refuses an empty needle", async () => {
  const vault = await makeVault();
  const upper = await searchVault(vault, "FISSURE");
  assert.ok(upper.ok);
  assert.ok(upper.value.length >= 1);
  assert.equal((await searchVault(vault, "   ")).ok, false);
});

test("writing a note creates folders as needed", async () => {
  const vault = await makeVault();
  const written = await writeNote(vault, join("Magic Items", "Ember Blade"), "# Ember Blade\n");
  assert.ok(written.ok);
  assert.match(await readFile(written.value, "utf8"), /Ember Blade/);
});

test("writing refuses to overwrite the DM's work unless told to", async () => {
  const vault = await makeVault();
  const first = await writeNote(vault, join("NPCs", "Bram Kelter"), "# Replaced\n");
  assert.equal(first.ok, false, "an existing note must not be clobbered silently");
  assert.match(first.ok ? "" : first.error, /already exists/);

  const forced = await writeNote(vault, join("NPCs", "Bram Kelter"), "# Replaced\n", true);
  assert.ok(forced.ok);
  assert.match(await readFile(forced.value, "utf8"), /Replaced/);
});

test("wikilinks are extracted in order, without duplicates", () => {
  const content = "See [[Aintport]] and [[Bram Kelter|the groundskeeper]], then [[Aintport]] again, and [[Zone 1#The Fissure]].";
  assert.deepEqual(wikilinks(content), ["Aintport", "Bram Kelter", "Zone 1"]);
});

test("a note with no links yields none", () => {
  assert.deepEqual(wikilinks("plain text"), []);
});

test("the configured vault is read back from campaign.json", async () => {
  const vault = await makeVault();
  const root = await mkdtemp(join(tmpdir(), "dnd-root-"));
  const set = await setVault(root, vault);
  assert.ok(set.ok);

  const resolved = await resolveVault(root);
  assert.ok(resolved.ok);
  assert.equal(resolved.value, vault);
});

test("a vault path that does not exist is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "dnd-root-"));
  const set = await setVault(root, join(tmpdir(), "definitely-not-a-vault"));
  assert.equal(set.ok, false);
  assert.match(set.ok ? "" : set.error, /vault not found/);
});

test("an unconfigured repo says how to configure one", async () => {
  const root = await mkdtemp(join(tmpdir(), "dnd-root-"));
  const before = process.env["DND_VAULT"];
  delete process.env["DND_VAULT"];
  try {
    const resolved = await resolveVault(root);
    assert.equal(resolved.ok, false);
    assert.match(resolved.ok ? "" : resolved.error, /dnd vault set/);
  } finally {
    if (before !== undefined) process.env["DND_VAULT"] = before;
  }
});
