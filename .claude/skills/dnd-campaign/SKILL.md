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

### Homebrew: effects blocks

Any homebrew the engine should apply — an item, weapon, armour, trait, spell
effect or permanent condition — carries its mechanics in a fenced block tagged
`effects` inside its wiki note. Write the prose for the DM as usual, then the
block underneath. **The block is the mechanics; the prose must say the same
thing in words.** If they disagree, the DM's prose is the intent: fix the
block, and say so.

One block holds one definition; a note may hold several blocks (a monster with
two traits). Validate every block you write before reporting it done:

    dnd homebrew check "<note>"     # parses, validates, and describes it in words

Read the description it prints back against the prose. If the engine's words
are not what the note means, the block is wrong.

**Format.** A strict YAML subset: `key: value`, `- ` lists, `{flow: maps}`,
`[flow, lists]`, numbers (a leading `+` is fine), `true`/`false`, quoted or
plain strings, `|` block text, `#` comments. Spaces only, never tabs. No
anchors, aliases or tags.

**Definition keys**

| Key | Meaning |
|---|---|
| `name` | Required. The item's name; also its id (`voidfang-katars`). |
| `kind` | Required. `trait`, `item`, `weapon`, `armor`, `spell` or `effect`. |
| `attunement` | `true` if it needs attunement. Unattuned, it does nothing. Max 3 attuned. |
| `text` | Optional summary. |
| `replaces-attack` | Weapons: the sheet attack it takes over (renamed to `name`, numbers kept). |
| `grants-attack` | Weapons: a new attack — `{bonus: prof + mod(str), damage: ["2d6 + mod(str):slashing"], melee: true, range: 5, long-range: 60}`. |
| `attack-tags` | Weapons: source tags every attack with it carries, e.g. `[unphased]` for a gravity hammer. |
| `creature-tags` | Tags the holder gains, e.g. `[fungal]`. |
| `effects` | The list of effects and features below. |

**An effect** is `{name, on, when, unless, may, uses | charges, do}`:

| Key | Meaning |
|---|---|
| `on` | The hook. Default `always`. See the table below. |
| `when` / `unless` | Conditions: `tag` (source tags, from `--tag` or the weapon), `target-tag` (creature tags on the target), `type` (damage type), `weapon` (attack name). Each takes one value or a list; all keys must hold. |
| `may` | `true` = optional. The engine only reports it; the DM opts in with `--effect "<name>"`. |
| `uses` / `charges` | `{max: <formula>, per: round | short-rest | long-rest | dawn, regain: <formula or dice>}`. Absent `regain` = all. A long rest also restores short-rest uses. |
| `name` | Required when the effect has `may` or uses; it is how the DM refers to it. |
| `do` | One action map, or a list of them. |

Weapons' `outgoing-damage`, `critical-hit` and `reduces-target-to-0` effects
fire only for attacks made **with that weapon**; its `attack-bonus`,
`damage-bonus` and `crit-range` grants count only for that weapon too.

**Hooks and the actions each allows**

| `on:` | When | Actions |
|---|---|---|
| `always` | While active | grant keys (below) — permanent |
| `incoming-damage` | The holder takes damage | `scale` |
| `outgoing-damage` | The holder deals weapon damage | `ignore: resistance`, `add-damage` |
| `critical-hit` | The holder crits | `saving-throw`, `condition`, `temphp`, timed grant |
| `reduces-target-to-0` | The holder's hit drops a creature to 0 HP | `condition`, `temphp`, timed grant |
| `would-drop-to-0` | The holder is about to drop to 0 HP | `set-hp` (required), timed grant, `condition`, `temphp` |
| `casts-spell` | The holder casts a damaging spell | `add-damage` (one target) |

**Actions**

| Action | Meaning |
|---|---|
| `ac`, `speed`, `attack-bonus`, `damage-bonus` | Add a whole number. |
| `save-bonus`, `check-bonus` | A number (all abilities) or `{dex: 2}`. |
| `crit-range` | Crit on this natural roll or higher (lowest wins). |
| `resist`, `immune`, `vulnerable` | A damage type or a list. |
| `resist-all: true` | Resistance to all damage. |
| `scale: 1/4`, `round: down` | Multiply incoming damage. `round`: `down` (default), `up`, `nearest`. |
| `ignore: resistance` | Outgoing damage ignores resistance — for the `when: {type}` types, or all. |
| `add-damage: "3d8:radiant"` | Extra damage dice, rolled with the attack (doubled on a crit). |
| `saving-throw: {ability: con, dc: 20}` with `on-fail:` / `on-success:` | The target saves; then the listed actions. |
| `condition: petrified` | Apply a condition; `to: target` (default where there is a target) or `self`. |
| `temphp: <formula>` | Temporary hit points (they do not stack; the larger wins). |
| `set-hp: <formula>` | `would-drop-to-0` only: what the holder drops to instead. |

Grants and conditions from a trigger need a duration, `until:`
`end-of-holder-next-turn`, `end-of-target-next-turn`, or `{rounds: N}`. "The end
of X's next turn" set during X's own turn lasts through the end of X's
following turn, as the rules read.

**Features** are reference-only: `{feature: <name>, text: <rule>, uses: {...}}`.
The engine tracks the uses (`dnd use <id> <name>`) and shows the text, but never
adjudicates it. Use a feature for anything about action economy, movement,
area, light, or an effect the vocabulary does not have — and say so.

**Formulas** are fixed arithmetic, never dice: whole numbers, `prof`, `level`,
`level(<class>)` (0 if the creature has no levels in it), `mod(<ability>)`,
`+ - *`, `/` (divides and rounds down), parentheses. Damage expressions use dice
notation and may contain the same names: `"1d8 + mod(str):slashing"`.

**Damage order** (pinned by tests), per damage packet: immunity → resistance
and vulnerability (a resistance an attacker ignores is skipped here) → homebrew
`scale` → then the packets are summed → temp HP → `would-drop-to-0` → hit
points. A spell's save halves before any of this.

**Examples** — the campaign's items, exactly as they validate:

```effects
name: Phased
kind: trait
effects:
  - on: incoming-damage
    unless: {tag: unphased}      # the DM tags gravity / dimensional attacks
    do: {scale: 1/4, round: down}
```

```effects
name: Voidfang Katars
kind: weapon
attunement: true
replaces-attack: ice katars
effects:
  - name: Cold That Does Not Care
    on: outgoing-damage
    when: {type: cold}
    do: {ignore: resistance}
  - name: Frozen in Stasis
    on: critical-hit
    do:
      saving-throw: {ability: con, dc: 20}
      on-fail:
        - condition: petrified
          until: end-of-holder-next-turn
  - feature: Shadowstep
    text: Swap places with your shadow as a free action, instead of spending an action or bonus action.
    uses: {max: 1, per: round}
```

```effects
name: Mantle of the Undying Wall
kind: item
attunement: true
effects:
  - name: Blood of the Wall
    on: reduces-target-to-0
    do: {temphp: level(fighter) + mod(con)}
  - name: The Wall Does Not Fall
    on: would-drop-to-0
    uses: {max: 1, per: long-rest}
    do:
      - set-hp: 1
      - resist-all: true
        until: end-of-holder-next-turn
  - feature: Doubled Warding
    text: Warding Maneuver can be used twice per round instead of once.
    uses: {max: 2, per: round}
```

```effects
name: Crown of Cataclysm
kind: item
attunement: true
effects:
  - name: Force of the Fall
    on: casts-spell
    when: {type: [cold, radiant]}
    may: true
    do: {add-damage: "2d10:force"}
  - feature: Crown Eternal
    text: Crown of Stars is always active and costs no spell slot. Spend one charge per mote.
    charges: {max: 7, regain: 1, per: dawn}
  - feature: The Sky Falls Once
    text: Cast Meteor Swarm without expending a spell slot; cast this way it deals cold damage only.
    uses: {max: 1, per: long-rest}
```

```effects
name: Fungicide Blade
kind: weapon
attunement: true
grants-attack:
  bonus: prof + mod(str)
  damage: ["2d6 + mod(str):slashing"]
  range: 5
effects:
  - do: {attack-bonus: 3, damage-bonus: 3}
  - name: Anti-Fungal
    on: outgoing-damage
    when: {target-tag: fungal}
    do: {add-damage: "3d8:radiant"}
  - feature: Sunbeam
    text: Cast Sunbeam (save DC 20) from the blade.
    uses: {max: 1, per: long-rest}
```

**Creature tags** come from a `**Tags:** fungal, continuance` line in a stat
block, and from `creature-tags`. Effects test them with `target-tag`.

**Loadouts.** `dnd equip <character> "<item note>" --attune [--as-attack "<sheet attack>"]`
records an item in `data/party/<id>.loadout.json`. The definition is re-read
from the wiki whenever the character joins an encounter, so editing the note is
enough to change the item. Use `--as-attack` when a generic weapon ("any
sword") becomes a specific attack already on the character's sheet.

**What the vocabulary cannot say yet** — write these as `feature`s and tell the
DM: action-economy changes, movement and areas, light and auras, spell effects
beyond damage, extra damage that applies only on a critical, "once per turn"
limits (use `per: round` only if per-round is what is meant), anything that
depends on positions.

## Running a monster from the wiki

    dnd wiki import "Sporeblight Goose"        # writes data/monsters/<id>.json
    dnd wiki import "Sporelord Maw" --dry-run  # show what it reads, write nothing
    dnd add sporeblight-goose --count 8

`dnd wiki import` reads the note from disk, which is the engine's job rather
than a read of yours: it is the one place `dnd` touches the wiki. If the DM has
just edited the stat block, it imports what OpenKnowledge has saved.

**Always read the import warnings, and tell the DM what is in them.** The
importer deliberately refuses to apply anything conditional that is not
written as an effects block (see above); a monster's effects blocks are
attached as traits and listed in the import output. Traits, reactions,
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
