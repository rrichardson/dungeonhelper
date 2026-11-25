# DM Assistant

A deterministic D&D 2024 (SRD 5.2) rules engine with a CLI, built to run
combat at the table without trusting anyone's mental arithmetic — including
the assistant's.

Zero runtime dependencies. No build step: Node 24+ runs the TypeScript
directly.

## Quick start

```bash
npm install                       # dev-only: typescript + @types/node
node src/cli/index.ts --help

node src/cli/index.ts new "Goblin Ambush"
node src/cli/index.ts add aria
node src/cli/index.ts add goblin --count 3
node src/cli/index.ts init
node src/cli/index.ts start
node src/cli/index.ts attack aria goblin-1 --weapon longsword
```

```
Aria → longsword → Goblin 1 (AC 15)
  d20: [10] +6 attack bonus = 16 vs AC 15 → HIT
  dmg: 1d8[8] +4 = 12 slashing
  Goblin 1: 7 → 0 HP (−12)
  ! Goblin 1 dies
  (seed table1#4)
```

Every die face, every modifier with its source, and the seed. Nothing is
summarised into a number you have to take on faith.

## Design

**Rules live in one place.** `src/engine/` is pure: no file access, no clock,
no randomness of its own. Every function takes an injected `Rng` and returns a
`Result`, so expected failures — a malformed dice expression, an incapacitated
attacker — are return values rather than exceptions. The CLI is a thin edge
that parses arguments, reads and writes files, and prints.

**Everything is reproducible.** Randomness comes from a seeded PRNG. The
encounter holds a seed and a roll counter, and each action derives its own
sub-seed from them, so every roll is independently re-runnable:

```bash
node src/cli/index.ts roll 1d20+6 --seed 'table1#4'
```

**Physical dice are first class.** Supply the faces the DM actually rolled and
the engine does the rest of the work:

```bash
node src/cli/index.ts attack aria goblin-1 --weapon longsword --dice 17,6
```

The count must match what the expression needs, or the command refuses.

**State is readable.** Encounters are plain JSON under `encounters/`, safe to
hand-edit between commands and re-validated on every load, so a typo fails
loudly instead of producing a wrong number later.

## What is implemented

Dice with keep/drop notation · d20 tests with advantage resolution (including
the rule that any advantage plus any disadvantage cancels) · attacks, criticals
doubling dice but not modifiers, auto-crits on paralyzed or unconscious targets
within 5 ft · cover · damage with resistance, immunity, vulnerability and temp
HP · massive-damage instant death · all fourteen 2024 conditions with their
mechanical effects, including prone by range and grappled by source · the 2024
exhaustion ladder · saving throws and ability checks with automatic failures ·
concentration, with the save rolled automatically after damage · death saves ·
initiative with the 2024 surprise rules and stable tie-breaking · homebrew
items, weapons, traits and effects defined as data in the wiki (see below).

Not yet modelled: spell effects beyond damage, movement and geometry, most
class features, and the merchant / settlement / wilderness generators.

## Importing from D&D Beyond

```bash
node src/cli/import-ddb.ts https://www.dndbeyond.com/characters/167935384
node src/cli/import-ddb.ts 167935384 --dry-run
```

D&D Beyond serves the *ingredients* of a sheet, not a computed one: no final
ability score, AC, HP maximum or attack bonus appears in the payload. The
importer derives each and shows its working, so the import can be checked once
against the real sheet rather than trusted silently:

```
AC    17              Armor of Gleaming, Chain Shirt 13 + Dex +2 (capped from +3) + Shield +2
DEX 17 (+3)           base 15 + Moderately Armored +1 + Zhentarim Mercenary ASI +1
eldritch blast  +6 to hit  1d10+3 force  (2 beams at level 5 · +3 from Agonizing Blast)
```

Attacks are derived from carried weapons and from spells requiring an attack
roll. Availability is not read from `prepared` — known-casters leave that false
on every spell they own, so a warlock filtered that way would import with no
offence at all. Anything the importer cannot determine becomes a warning rather
than a number: unscaled cantrip dice, sustained damage such as Witch Bolt's
follow-up, magic items with unstated bonuses, and 2014-ruleset sheets (which
also set exit code 2).

The character's privacy must be set to Public.

## Stat blocks

JSON under `data/party/` and `data/monsters/`:

```json
{
  "id": "goblin",
  "name": "Goblin",
  "ac": 15,
  "hp": { "max": 7 },
  "abilities": { "str": 8, "dex": 15, "con": 10, "int": 10, "wis": 8, "cha": 8 },
  "proficiencyBonus": 2,
  "speed": 30,
  "attacks": [
    { "name": "scimitar", "bonus": 4, "damage": [{ "expression": "1d6+2", "type": "slashing" }] }
  ]
}
```

Optional: `isPlayer`, `saveProficiencies`, `resistances`, `immunities`,
`vulnerabilities`, `conditionImmunities`, `conditions`, `exhaustion`, `notes`.
Validation names the exact field at fault.

## SRD lookup

```bash
node src/cli/index.ts lookup monster "owlbear"
node src/cli/index.ts fetch "Goblin Warrior"
```

`fetch` pulls a creature from the Open5e 2024 SRD and writes a runnable stat
block into `data/monsters/`, deriving proficiency bonus from challenge rating
(the API leaves it null) and reading an attack's damage type from
`extra_damage_type` when the primary field is empty. Conditional damage riders
are reported rather than applied, since they depend on how the roll came out.

## Campaign wiki

The campaign's knowledge base is an [OpenKnowledge](https://openknowledge.ai)
project, shared live between the DM and the assistant. The assistant reads and
writes notes through OpenKnowledge's MCP tools; `dnd` only locates the campaign
and imports stat blocks from it.

```bash
node src/cli/index.ts wiki set "~/Projects/wiki/D&D/My Campaign"
node src/cli/index.ts wiki status
node src/cli/index.ts wiki import "Sporeblight Goose"
```

On Windows the same commands take a Windows path:

```powershell
node src\cli\index.ts wiki set "C:\Users\dm\wiki\D&D\My Campaign"
```

The campaign folder lives in `campaign.json` (git-ignored, since it is an
absolute path), or `DND_WIKI` in the environment. A relative path or a leading
`~` is resolved when it is set. `wiki status` also reports the OpenKnowledge
project containing the campaign (the nearest folder above it with
`.ok/config.yml`) and the campaign's path within it, which is how the
assistant addresses notes through OpenKnowledge. If there is none, run
`ok init` in the folder you want as the project root.

`wiki import` parses a Markdown stat block into a runnable creature, handling
both layouts wikis use — `## Armor Class` with the value beneath, and inline
`**Armor Class** 16` — with or without YAML frontmatter, taking the name from
the frontmatter `title` when there is one. It reads the first sentence of a
`*Hit:*` line as the damage of one hit and treats anything after it as a
conditional rider to be applied by hand, so a "bleed on a critical" never
inflates every swing. Traits, reactions, legendary and lair actions are
reported, not invented.

Notes written for Obsidian (no frontmatter, `[[wikilinks]]`, callouts) keep
working as they are; OpenKnowledge reads that syntax.

## Homebrew effects

Homebrew items, weapons, armour, traits and permanent effects are written as
data inside the wiki note that describes them, in a fenced block tagged
`effects`. The prose is for people; the block is for the engine:

````markdown
```effects
name: Phased
kind: trait
effects:
  - on: incoming-damage
    unless: {tag: unphased}
    do: {scale: 1/4, round: down}
```
````

Every definition uses a small fixed vocabulary — static modifiers, damage
pipeline steps, triggers (critical hit, reducing a creature to 0, would drop
to 0, casting a spell), timed conditions and grants, uses and charges, and a
safe formula language (`level(fighter) + mod(con)`). Each word is implemented
once in `src/engine/homebrew/` and pinned by a test, and every number an effect
changes is printed with the effect's name. The full authoring reference is in
the `dnd-campaign` skill; how to run it at the table is in `dnd-combat`.

```bash
node src/cli/index.ts homebrew check "Voidfang Katars"     # validate and describe a note's block
node src/cli/index.ts equip d-jarrak "Voidfang Katars" --attune
node src/cli/index.ts attack d-jarrak harmer-1 --weapon "voidfang katars"
node src/cli/index.ts attack bokun harmer-1 --weapon "fungicide blade" --tag unphased
node src/cli/index.ts cast dagant "Cone of Cold" --save con --damage 8d8:cold \
    --targets a,b --effect "Force of the Fall" --effect-target a
node src/cli/index.ts use d-jarrak Shadowstep               # spend a tracked use
node src/cli/index.ts dawn                                   # per-dawn charges regain
```

Party loadouts live in `data/party/<id>.loadout.json`, separate from the D&D
Beyond import, and are read from the wiki each time the character is added to
an encounter. A monster note's effects blocks are attached as traits by
`wiki import`, and a `**Tags:** fungal, continuance` line gives it creature
tags that effects can test. `DND_PARTY_DIR` points party sheets and loadouts at
another folder for scratch runs.

## Generation

```bash
node src/cli/index.ts gen merchant --kind smithy
node src/cli/index.ts gen town --size village
node src/cli/index.ts gen wilderness --width 10 --height 6 --terrain forest
```

Seeded like everything else, so a location reproduces exactly from its seed
and stays stable once the party has visited it.

## Tests

```bash
npm test
```

Rules are pinned by name — `"a natural 1 counts as two failures"`,
`"advantage and disadvantage cancel to a single normal roll"` — so a failure
tells you which rule broke.

## Content

Stat blocks under `data/` are examples. Rules content derives from the System
Reference Document 5.2, released by Wizards of the Coast under CC-BY-4.0.
