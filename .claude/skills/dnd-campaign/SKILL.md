---
name: dnd-campaign
description: Manage an adventure or campaign through the shared OpenKnowledge campaign wiki — the realm, adventure hooks, plot, NPCs, monsters, magic items, locations, rooms and session notes. Use when writing or reading campaign content, preparing or running a session, or when the DM refers to the wiki, the vault, the campaign, or any note in it.
---

# Campaign wiki

The campaign is a folder of Markdown notes inside an **OpenKnowledge** project,
and it is **shared, live**. The DM writes the realm, the adventure hook, the
plot and whatever else they want, often with the note open in OpenKnowledge as
you work. You write the content you generate. Both of you read all of it.

The wiki is the canon. The engine (`dnd` commands, `data/`, `encounters/`) is
live mechanical state. When the two disagree about a creature, the wiki is the
author's intent and the engine is what is actually happening in this fight.

This skill carries the campaign's conventions. **How** to read and write
markdown in an OpenKnowledge project — the MCP tools, the rule against native
file tools, write outcomes, links — belongs to the project's `open-knowledge`
skill. Follow it; where the two overlap, it governs the mechanics and this
skill governs the campaign.

## Find the campaign first

    dnd wiki status          # add --json to read the values back

It prints the campaign folder, the OpenKnowledge project that contains it, and
the **campaign path inside that project** (e.g. `D&D/The Fungicide Order`).
Prefix that path onto every OpenKnowledge tool call, and confirm the project's
content root with `config({ key: "content.dir" })` if paths do not resolve.

The location is configured, never assumed — the DM runs this on macOS and
Windows alike:

    dnd wiki set "<path to campaign folder>"   # stored in campaign.json
    DND_WIKI=<path>                            # overrides it for one shell

If status says the folder is **not inside an OpenKnowledge project**, stop and
tell the DM: they run `ok init` in the folder (or a parent) or open it in OK
Desktop. Do not run `ok init` on the DM's wiki yourself. If the OpenKnowledge
MCP tools are not available in this session, say so plainly rather than
falling back to editing the files directly.

## Before you write anything, read

Read through OpenKnowledge, never with native file tools on the notes:

    exec("ls -A <campaign>/Monsters")        notes in a folder, with frontmatter
    exec("cat <campaign>/CAMPAIGN.md")       a whole note
    exec("grep -rn fissure <campaign>")      every literal mention
    search("who guards the fissure")         ranked retrieval
    links(...)                               what a note links to, and what links to it

Search before creating. The DM may already have written the NPC, named the
town, or decided the plot point. Inventing a second version of something that
already exists is the main way this collaboration goes wrong.

Read `CAMPAIGN.md` first in any new campaign — it is the DM's brief for the
whole adventure, and everything else should be consistent with it.

## Writing notes

Write with `write` (new notes) and `edit` (changes), and give every write a
one-line `summary` — it is what the DM sees in the note's timeline.

**Never overwrite or edit a note you did not write without asking.** `write`
on an existing path replaces it wholesale; do not use it on the DM's notes. If
a note needs changing, say what you would change and let the DM decide, then
make exactly that change with `edit`.

### Existing notes vs new notes

Notes written before the move to OpenKnowledge have no frontmatter, use
`[[wikilinks]]` and Obsidian callouts. OpenKnowledge still reads all of that.
**Leave it as it is** — do not add frontmatter or convert links in the DM's
notes unless they ask for it.

New notes you write follow OpenKnowledge conventions:

- **Frontmatter** with `title`, a one-line `description`, and `tags`
  (`monster`, `npc`, `item`, `room`, `session`, …). The title is the creature's
  or character's name; the body may still open with `# Title`.
- **Standard links**, relative to the note: `[Professor Aldric Wynn](../NPCs/Professor%20Aldric%20Wynn.md)`.
  Link every entity you mention — links are how the DM navigates at the table.
- **Every link must resolve.** When you mention something that has no note
  yet, either write a short stub for it in the right folder (and say so), or
  leave the name as plain text and list it for the DM as a note worth writing.
  Read `brokenLinks` after every write and fix what it reports.
- **Callouts** for DM-facing warnings: `> [!WARNING]` then the text.
- `---` as a section break between major parts of a stat block. (Only after the
  frontmatter — a note's first `---` opens its frontmatter.)
- Before writing into a folder for the first time in a session, `exec("ls -A
  <folder>")` it, and use a template if the folder offers one.

### Sources

OpenKnowledge asks for every factual claim to cite a source. Campaign content
is the DM's fiction: its source is the canon itself. Link the note that
establishes a fact (`CAMPAIGN.md`, the NPC's note) rather than inventing a
citation, and never present an invented detail as if the DM had decided it.
When you reference a published rule, name it (e.g. "SRD 5.2, Grappled") — do
not paste a web link into the note.

### Where things go

| Folder | Holds |
|---|---|
| `CAMPAIGN.md` | The DM's brief: premise, level, location, tone |
| `DM Reference/` | Player characters, spatial layouts, summaries, epilogues |
| `Monsters/` | One stat block per creature |
| `NPCs/` | People, with appearance, personality, roleplaying notes |
| `Magic Items/` | Items, with mechanics spelled out |
| `Rooms/<Zone>/` | Locations, grouped by zone or region |
| `Lair/` | Lair actions and regional effects |
| `Dungeon Events/` | Random tables |

### Monster notes

Write a full stat block. The engine can import it, so the mechanical fields
must be exact:

```markdown
---
title: Sporeblight Goose
description: A fungus-ridden goose that fights in flocks.
tags: [monster]
---

# Sporeblight Goose

**Type/Size/Alignment:** Beast (Fungal-Infected), Medium, Chaotic Evil

## Armor Class
13 (fungal chitin)

## Hit Points
55 (10d8 + 10)

## Speed
30 ft., fly 50 ft.

## Ability Scores
| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 14 (+2) | 15 (+2) | 13 (+1) | 3 (-4) | 12 (+1) | 5 (-3) |

## Saving Throws
DEX +4, CON +3

## Damage Immunities
Poison, Psychic

## Challenge
4 (1,100 XP)

## Actions

**Spore Bite.** *Melee Weapon Attack:* +4 to hit, reach 5 ft., one target. *Hit:* 7 (1d8 + 2) piercing damage plus 4 (1d8) poison damage.
```

The importer takes the creature's name from the frontmatter `title`, then the
`# Title` heading, then the filename.

Keep attack lines in exactly that shape — `**Name.** *Melee Weapon Attack:* +N
to hit, reach N ft., one target. *Hit:* X (NdM + K) type damage` — because that
is what the importer reads. Put conditional riders in a **second sentence**
("On a critical hit, …"), never inside the first: the importer treats the first
sentence as the damage of one hit, and anything after it as a rider you apply
by hand.

Finish with **Lore & Tactics**: how the creature fights, and what encounter
sizes are worth running. That part is for the DM, not the engine.

### NPC notes

`**Race/Gender:**`, `**Age:**`, `**Title:**`, `**Status:**`, then
`## Appearance`, `## Personality Traits`, `## Roleplaying Notes`, and
`## Key Information They Provide`. The roleplaying notes matter most at the
table — concrete verbal tics and behaviours, not adjectives.

### Room notes

Open with a `## Secret Summary` table (secret, check type, DC, benefit) so the
DM can scan it mid-session, then `## Description` (read-aloud prose),
`## Contents`, then each secret in full with how it is found and what it
reveals.

## Running a monster from the wiki

    dnd wiki import "Sporeblight Goose"        # writes data/monsters/<id>.json
    dnd wiki import "Sporelord Maw" --dry-run  # show what it reads, write nothing
    dnd add sporeblight-goose --count 8

`dnd wiki import` reads the note from disk, which is the engine's job rather
than a read of yours: it is the one place `dnd` touches the wiki. If the DM has
just edited the stat block, it imports what OpenKnowledge has saved.

**Always read the import warnings, and tell the DM what is in them.** The
importer deliberately refuses to apply anything conditional. Traits, reactions,
legendary and lair actions, recharge abilities and riders like "extra damage if
the target is prone" are all reported and left to you. Apply a rider with
`--extra-damage` when its condition is actually met:

    dnd attack sporeblight-panda aria --weapon claw --distance 5 \
        --extra-damage "2d6:slashing"

If a stat block fails to import, the note's mechanical fields need fixing —
say which field and offer the correction rather than hand-rolling the fight.

## During a session

Keep the wiki current as play reveals things, but ask before editing the DM's
notes. Good candidates for you to write without asking:

- new creatures, items and NPCs you generated this session
- session summaries and battle logs in `DM Reference/`
- notes for locations the party reached that had none

Generated content from `dnd gen merchant|town|wilderness` belongs in the wiki
too — record the seed in the note so the place reproduces exactly if it is
needed again.

When the DM describes realm, plot or hooks in conversation, offer to write it
into the wiki. That is the point of the collaboration: what is said at the
table should not be lost when the session ends.
