---
name: dnd-campaign
description: Manage an adventure or campaign through the shared Obsidian wiki vault — the realm, adventure hooks, plot, NPCs, monsters, magic items, locations, rooms and session notes. Use when writing or reading campaign content, preparing or running a session, or when the DM refers to the wiki, the vault, the campaign, or any note in it.
---

# Campaign wiki

The vault is an Obsidian folder of Markdown notes, and it is **shared**. The DM
writes the realm, the adventure hook, the plot and whatever else they want.
You write the content you generate. Both of you read all of it.

The vault is the canon. The engine (`dnd` commands, `data/`, `encounters/`) is
live mechanical state. When the two disagree about a creature, the vault is the
author's intent and the engine is what is actually happening in this fight.

## Before you write anything, read

    dnd vault status              where the vault is and what is in it
    dnd vault list Monsters       notes in a folder
    dnd vault search "fissure"    every mention, with note and line
    dnd vault show "Bram Kelter"  a whole note
    dnd vault links "Sporelord Maw"   what a note refers to

Search before creating. The DM may already have written the NPC, named the
town, or decided the plot point. Inventing a second version of something that
already exists is the main way this collaboration goes wrong.

Read `CAMPAIGN.md` first in any new vault — it is the DM's brief for the whole
adventure, and everything else should be consistent with it.

## Writing notes

**Never overwrite a note you did not write without asking.** The tool refuses
by default; do not reach for the override to get past it. If a note exists and
needs changing, say what you would change and let the DM decide.

Conventions observed in this vault, which you should match:

- No YAML frontmatter. The note opens with `# Title`.
- Key facts as bold labels: `**Armor Class** 15` or a `## Armor Class` heading
  with the value beneath. Either is fine; be consistent within a note.
- Obsidian callouts for DM-facing warnings:
  `> [!warning] **Swarm creature — deploy in numbers**`
- `---` as a section break between major parts of a stat block.
- Wikilink every entity you mention: `[[Professor Aldric Wynn]]`,
  `[[Elemental Fonts of Power]]`. Links are how the DM navigates at the table,
  so link generously — a link to a note that does not exist yet is a useful
  note to write next, not an error.

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

    dnd vault import "Sporeblight Goose"        # writes data/monsters/<id>.json
    dnd vault import "Sporelord Maw" --dry-run  # show what it reads, write nothing
    dnd add sporeblight-goose --count 8

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

Keep the vault current as play reveals things, but ask before editing the DM's
notes. Good candidates for you to write without asking:

- new creatures, items and NPCs you generated this session
- session summaries and battle logs in `DM Reference/`
- notes for locations the party reached that had none

Generated content from `dnd gen merchant|town|wilderness` belongs in the vault
too — record the seed in the note so the place reproduces exactly if it is
needed again.

When the DM describes realm, plot or hooks in conversation, offer to write it
into the vault. That is the point of the collaboration: what is said at the
table should not be lost when the session ends.
