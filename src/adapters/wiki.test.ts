import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listNotes, findNote, resolveWiki, setWiki, findProject, expandPath } from "./wiki.ts";

async function makeWiki(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dnd-wiki-"));
  await mkdir(join(dir, "Monsters"), { recursive: true });
  await mkdir(join(dir, "NPCs"), { recursive: true });
  await mkdir(join(dir, ".obsidian"), { recursive: true });
  await mkdir(join(dir, ".ok", "templates"), { recursive: true });
  await mkdir(join(dir, "Rooms", "Zone 1"), { recursive: true });

  await writeFile(join(dir, "CAMPAIGN.md"), "# Campaign\n\nThe party enters [Aintport](./Aintport.md).\n");
  await writeFile(join(dir, "Monsters", "Cellar Hound.md"), "# Cellar Hound\n\nA fungal beast.\n");
  await writeFile(join(dir, "NPCs", "Bram Kelter.md"), "---\ntitle: Bram Kelter\n---\n\nGroundskeeper.\n");
  await writeFile(join(dir, "Rooms", "Zone 1", "The Fissure.mdx"), "# The Fissure\n\nA chasm.\n");
  await writeFile(join(dir, ".obsidian", "workspace.json"), "{}");
  await writeFile(join(dir, ".ok", "templates", "monster.md"), "# Template\n");
  await writeFile(join(dir, "Monsters", "notes.txt"), "not a note");
  return dir;
}

const NO_ENV = {};

test("every Markdown note is listed, and nothing else", async () => {
  const wiki = await makeWiki();
  const notes = await listNotes(wiki);
  assert.ok(notes.ok);
  const paths = notes.value.map((n) => n.path);

  assert.equal(notes.value.length, 4);
  assert.ok(paths.includes("Monsters/Cellar Hound.md"));
  assert.ok(paths.includes("Rooms/Zone 1/The Fissure.mdx"), "OpenKnowledge treats .mdx as a note too");
  assert.ok(!paths.some((p) => p.includes(".ok")), "OpenKnowledge templates are not campaign notes");
  assert.ok(!paths.some((p) => p.includes(".obsidian")));
  assert.ok(!paths.some((p) => p.endsWith(".txt")));
});

test("note paths use forward slashes whatever the platform", async () => {
  const wiki = await makeWiki();
  const notes = await listNotes(wiki);
  assert.ok(notes.ok);

  const room = notes.value.find((n) => n.title === "The Fissure")!;
  assert.equal(room.folder, "Rooms/Zone 1");
  assert.equal(room.path, "Rooms/Zone 1/The Fissure.mdx");

  const campaign = notes.value.find((n) => n.title === "CAMPAIGN")!;
  assert.equal(campaign.folder, "", "root notes have no folder");
});

test("a note is found by exact title, case-insensitively", async () => {
  const wiki = await makeWiki();
  const found = await findNote(wiki, "cellar hound");
  assert.ok(found.ok);
  assert.equal(found.value.title, "Cellar Hound");
  assert.match(found.value.content, /fungal beast/);
});

test("a note in a nested folder is read back", async () => {
  const wiki = await makeWiki();
  const found = await findNote(wiki, "The Fissure");
  assert.ok(found.ok);
  assert.match(found.value.content, /A chasm/);
});

test("a unique partial title is accepted", async () => {
  const wiki = await makeWiki();
  const found = await findNote(wiki, "Bram");
  assert.ok(found.ok);
  assert.equal(found.value.title, "Bram Kelter");
});

test("an ambiguous title is refused with the candidates named", async () => {
  const wiki = await makeWiki();
  await writeFile(join(wiki, "Monsters", "Cellar Hound Alpha.md"), "# Cellar Hound Alpha\n");
  const found = await findNote(wiki, "Cellar Hound A");
  assert.ok(found.ok, "a unique partial still resolves");

  const ambiguous = await findNote(wiki, "Cellar");
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.ok ? "" : ambiguous.error, /matches several notes/);
});

test("an exact title wins over a longer partial match", async () => {
  const wiki = await makeWiki();
  await writeFile(join(wiki, "Monsters", "Cellar Hound Alpha.md"), "# Cellar Hound Alpha\n");
  const found = await findNote(wiki, "Cellar Hound");
  assert.ok(found.ok, "the exact title should resolve despite the longer sibling");
  assert.equal(found.value.title, "Cellar Hound");
});

test("a missing note is reported plainly", async () => {
  const wiki = await makeWiki();
  const found = await findNote(wiki, "Nonexistent");
  assert.equal(found.ok, false);
  assert.match(found.ok ? "" : found.error, /no note titled/);
});

// ── Locating the campaign ─────────────────────────────────────────────────

test("the configured campaign is read back from campaign.json", async () => {
  const wiki = await makeWiki();
  const root = await mkdtemp(join(tmpdir(), "dnd-root-"));
  const set = await setWiki(root, wiki);
  assert.ok(set.ok);
  assert.deepEqual(JSON.parse(await readFile(join(root, "campaign.json"), "utf8")), { wiki });

  const resolved = await resolveWiki(root, NO_ENV);
  assert.ok(resolved.ok);
  assert.equal(resolved.value, wiki);
});

test("a campaign.json written before OpenKnowledge, with a vault key, still resolves", async () => {
  const wiki = await makeWiki();
  const root = await mkdtemp(join(tmpdir(), "dnd-root-"));
  await writeFile(join(root, "campaign.json"), JSON.stringify({ vault: wiki }));
  const resolved = await resolveWiki(root, NO_ENV);
  assert.ok(resolved.ok);
  assert.equal(resolved.value, wiki);
});

test("DND_WIKI in the environment wins over campaign.json", async () => {
  const configured = await makeWiki();
  const overridden = await makeWiki();
  const root = await mkdtemp(join(tmpdir(), "dnd-root-"));
  await setWiki(root, configured);

  const resolved = await resolveWiki(root, { DND_WIKI: overridden });
  assert.ok(resolved.ok);
  assert.equal(resolved.value, overridden);
});

test("a campaign path that does not exist is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "dnd-root-"));
  const set = await setWiki(root, join(tmpdir(), "definitely-not-a-campaign"));
  assert.equal(set.ok, false);
  assert.match(set.ok ? "" : set.error, /not found/);
});

test("a configured campaign that has since moved says how to repoint it", async () => {
  const root = await mkdtemp(join(tmpdir(), "dnd-root-"));
  await writeFile(join(root, "campaign.json"), JSON.stringify({ wiki: join(tmpdir(), "moved-away") }));
  const resolved = await resolveWiki(root, NO_ENV);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.error, /dnd wiki set/);
});

test("an unconfigured repo says how to configure one", async () => {
  const root = await mkdtemp(join(tmpdir(), "dnd-root-"));
  const resolved = await resolveWiki(root, NO_ENV);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.error, /dnd wiki set/);
});

test("a typed path is made absolute against the working directory", () => {
  const cwd = resolve("/work");
  assert.equal(expandPath("campaigns/Fungus", cwd, resolve("/home/dm")), resolve(cwd, "campaigns/Fungus"));
  assert.equal(expandPath("  /abs/wiki  ", cwd, resolve("/home/dm")), resolve("/abs/wiki"));
});

test("a leading tilde is the home directory, with either slash", () => {
  const home = resolve("/home/dm");
  assert.equal(expandPath("~", "/work", home), home);
  assert.equal(expandPath("~/wiki/D&D", "/work", home), join(home, "wiki", "D&D"));
  assert.equal(expandPath("~\\wiki", "/work", home), resolve(join(home, "\\wiki")));
  assert.equal(expandPath("~other/wiki", "/work", home), resolve("/work", "~other/wiki"),
    "only a bare tilde is the home directory");
});

// ── The OpenKnowledge project ─────────────────────────────────────────────

async function makeProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "dnd-ok-"));
  await mkdir(join(project, ".ok"));
  await writeFile(join(project, ".ok", "config.yml"), "# OpenKnowledge — project configuration\n");
  return project;
}

test("the OpenKnowledge project is found above the campaign folder", async () => {
  const project = await makeProject();
  const campaign = join(project, "D&D", "The Fungicide Order");
  await mkdir(campaign, { recursive: true });

  const found = await findProject(campaign);
  assert.deepEqual(found, { root: project, campaign: "D&D/The Fungicide Order" });
});

test("a campaign folder that is itself the project has an empty campaign path", async () => {
  const project = await makeProject();
  assert.deepEqual(await findProject(project), { root: project, campaign: "" });
});

test("a folder's own .ok for templates is not mistaken for the project root", async () => {
  const project = await makeProject();
  const campaign = join(project, "Fungus Amongus");
  await mkdir(join(campaign, ".ok", "templates"), { recursive: true });
  assert.deepEqual(await findProject(campaign), { root: project, campaign: "Fungus Amongus" });
});

test("the user-wide ~/.ok settings folder does not make home a project", async () => {
  const home = await mkdtemp(join(tmpdir(), "dnd-home-"));
  await mkdir(join(home, ".ok", "bin"), { recursive: true });
  await writeFile(join(home, ".ok", "skill-state.yml"), "schema: 1\n");
  const campaign = join(home, "wiki", "D&D");
  await mkdir(campaign, { recursive: true });
  assert.equal(await findProject(campaign), undefined);
});

test("a folder outside any OpenKnowledge project has none", async () => {
  const plain = await mkdtemp(join(tmpdir(), "dnd-plain-"));
  assert.equal(await findProject(plain), undefined);
});
