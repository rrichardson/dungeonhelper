# dungeonhelper

A deterministic D&D 2024 (SRD 5.2) rules engine with a one-word CLI, `dnd`,
built to run the game at the table without trusting anyone's mental
arithmetic, including the AI assistant's. It also reads the campaign wiki:
stat blocks and homebrew mechanics are written as notes and imported into
runnable creatures and items.

Zero runtime dependencies. No build step: Node 24+ runs the TypeScript
directly.

## Install

```bash
git clone <this repo> dungeonhelper && cd dungeonhelper
npm install                 # dev-only: typescript + @types/node, for tests and typecheck
```

The CLI is `bin/dnd`, a small wrapper around `node src/cli/index.ts`. It works
from any directory. Put it on your PATH once and it is just `dnd`:

```bash
ln -s "$PWD/bin/dnd" /usr/local/bin/dnd      # or add dungeonhelper/bin to PATH
dnd --help
```

On Windows, `bin\dnd.cmd` is the same wrapper. Add the `bin` folder to `PATH`
and type `dnd`.

Without either, `./bin/dnd <command>` from the repo root (or
`node src/cli/index.ts <command>`) does exactly the same thing.

## Quick start

```bash
dnd new "Goblin Ambush"
dnd add aria
dnd add goblin --count 3
dnd init --all
dnd start
dnd attack aria goblin-1 --weapon longsword --distance 5
```

```
Aria → longsword → Goblin 1 (AC 15)
  d20: [10] +6 attack bonus = 16 vs AC 15 → HIT
  distance 5 ft
  dmg: 1d8[8] +4 = 12 slashing
  Goblin 1: 7 → 0 HP (−12)
  ! Goblin 1 dies
  (seed table1#4)
```

Every die face, every modifier with its source, and the seed. Nothing is
summarised into a number you have to take on faith.

## Commands at a glance

`dnd --help` is the full list. Add `--json` to any command for
machine-readable output, and `--encounter NAME` to work on an encounter other
than the current one.

| Area | Commands |
| --- | --- |
| Encounter | `new`, `add`, `remove`, `init`, `start`, `next`, `status`, `log`, `encounters`, `sheets` |
| Resolution | `attack`, `cast`, `damage`, `heal`, `temphp`, `save`, `check`, `deathsave`, `stabilize`, `condition`, `exhaustion`, `concentrate`, `reaction` |
| Resources | `slots`, `rest short`, `rest long`, `dawn`, `use` |
| Homebrew | `homebrew check / show / attach / detach / attune`, `equip`, `unequip` |
| Campaign wiki | `wiki status`, `wiki set`, `wiki import` |
| Characters | `import` (D&D Beyond) |
| SRD | `lookup monster / spell / condition`, `fetch` |
| Generation | `gen merchant`, `gen town`, `gen wilderness` |
| Utility | `roll` |

## Design

**Rules live in one place.** `src/engine/` is pure: no file access, no clock,
no randomness of its own. Every function takes an injected `Rng` and returns a
`Result`, so expected failures (a malformed dice expression, an incapacitated
attacker) are return values rather than exceptions. `src/adapters/` is the
edge that reads and writes files; `src/cli/` only parses arguments and prints.

**Everything is reproducible.** Randomness comes from a seeded PRNG. The
encounter holds a seed and a roll counter, and each action derives its own
sub-seed from them, so every roll can be re-run on its own:

```bash
dnd roll 1d20+6 --seed 'table1#4'
```

**Physical dice are first class.** Supply the faces the DM actually rolled:

```bash
dnd roll 4d6kh3 --dice 5,3,6,2
```

The count must match what the expression needs, or the command refuses.

**Space belongs to the DM.** The engine has no map. Distance, adjacency, cover
and line of sight are facts the DM states (`--distance`, `--threatened`,
`--cover`, `--adv` / `--dis` with a reason), and the engine never guesses them.

**State is readable.** Encounters are plain JSON under `encounters/`, safe to
hand-edit between commands and re-validated on every load, so a typo fails
loudly instead of producing a wrong number later.

## What is implemented

Dice with keep/drop notation · d20 tests with advantage resolution (including
the rule that any advantage plus any disadvantage cancels) · attacks, criticals
doubling dice but not modifiers, auto-crits on paralyzed or unconscious targets
within 5 ft, range and reach from a stated distance · cover · save-based spells
with area damage rolled once · damage with resistance, immunity, vulnerability
and temp HP · massive-damage instant death · all fourteen 2024 conditions with
their mechanical effects, including prone by range and grappled by source ·
the 2024 exhaustion ladder · saving throws and ability checks with automatic
failures · concentration, with the save rolled automatically after damage ·
death saves · initiative with the 2024 surprise rules and stable
tie-breaking · spell slots, short and long rests, reactions · homebrew items,
weapons, traits and effects defined as data in the wiki · seeded merchant,
settlement and wilderness generation.

Not yet modelled: spell effects beyond damage, movement and geometry, and most
class features. When something is not modelled, the engine says so rather
than approximating.

## Importing from D&D Beyond

```bash
dnd import https://www.dndbeyond.com/characters/167935384
dnd import 167935384 --dry-run
```

The character's privacy must be set to Public. The sheet is written to
`data/party/<id>.json`.

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
roll. Availability is not read from `prepared`: known-casters leave that false
on every spell they own, so a warlock filtered that way would import with no
offence at all. Anything the importer cannot determine becomes a warning rather
than a number: unscaled cantrip dice, sustained damage such as Witch Bolt's
follow-up, magic items with unstated bonuses, and 2014-ruleset sheets (which
also set exit code 2).

Re-importing replaces the sheet but never touches the character's loadout
(see [Homebrew effects](#homebrew-effects)).

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
`vulnerabilities`, `conditionImmunities`, `conditions`, `exhaustion`,
`spellcastingAbility`, `spellSlots`, `hitDice`, `attacksPerAction`, `notes`.
Validation names the exact field at fault.

Most stat blocks don't need writing by hand: `dnd import` makes party sheets,
`dnd fetch` makes SRD monsters, and `dnd wiki import` makes monsters from the
campaign wiki.

## SRD lookup

```bash
dnd lookup monster "owlbear"
dnd lookup spell "fireball"
dnd fetch "Goblin Warrior"            # writes a runnable stat block to data/monsters/
```

`fetch` pulls a creature from the Open5e 2024 SRD and writes a runnable stat
block into `data/monsters/`, deriving proficiency bonus from challenge rating
(the API leaves it null) and reading an attack's damage type from
`extra_damage_type` when the primary field is empty. Conditional damage riders
are reported rather than applied, since they depend on how the roll came out.
The 2024 SRD renames many creatures (the goblin is "Goblin Warrior"), so
search first if a name is not found.

## Campaign wiki

The campaign's knowledge base is an [OpenKnowledge](https://openknowledge.ai)
project, shared live between the DM and the assistant. The assistant reads and
writes notes through OpenKnowledge's MCP tools; `dnd` only locates the campaign
and imports from it.

```bash
dnd wiki set "~/Projects/wiki/D&D/My Campaign"
dnd wiki status
dnd wiki import "Sporeblight Goose" --dry-run
dnd wiki import "Sporeblight Goose"
```

On Windows the same commands take a Windows path:

```powershell
dnd wiki set "C:\Users\dm\wiki\D&D\My Campaign"
```

The campaign folder lives in `campaign.json` (git-ignored, since it is an
absolute path), or `DND_WIKI` in the environment. A relative path or a leading
`~` is resolved when it is set. `wiki status` also reports the OpenKnowledge
project containing the campaign (the nearest folder above it with
`.ok/config.yml`) and the campaign's path within it, which is how the
assistant addresses notes through OpenKnowledge. If there is none, run
`ok init` in the folder you want as the project root.

Notes are found by title, anywhere inside the campaign folder. Notes in other
campaigns are not visible.

`wiki import` parses a Markdown stat block into a runnable creature, handling
both layouts wikis use (`## Armor Class` with the value beneath, and inline
`**Armor Class** 16`), with or without YAML frontmatter, taking the name from
the frontmatter `title` when there is one. Melee and ranged attack lines are
both read. It reads the first sentence of a `*Hit:*` line as the damage of one
hit and treats anything after it as a conditional rider to be applied by hand,
so a "bleed on a critical" never inflates every swing. A `**Tags:**` line
gives the creature tags that homebrew effects can test. Traits, reactions,
legendary and lair actions are reported, not invented, unless the note gives
them an effects block.

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

Every definition uses a small fixed vocabulary:

- **Static modifiers:** AC, speed, saves, checks, attack and damage bonuses,
  crit range, resistances, immunities and vulnerabilities.
- **Damage pipeline steps:** scale incoming damage, ignore resistance, add
  extra damage.
- **Triggers:** a critical hit, reducing a creature to 0, would drop to 0,
  casting a spell.
- **Results:** saving throws, timed conditions, temp HP, setting HP.
- **Resources:** uses and charges per round, rest or dawn.
- **Formulas:** a safe formula language, such as `level(fighter) + mod(con)`.

Each word is implemented once in `src/engine/homebrew/` and pinned by a test,
and every number an effect changes is printed with the effect's name. Anything
the engine can't see (movement, areas, action economy) is a `feature`: its
uses are tracked and its text is shown, but the DM applies it. The full
authoring reference is in the `dnd-campaign` skill; how to run it at the table
is in `dnd-combat`.

```bash
dnd homebrew check "Voidfang Katars"                  # validate and describe a note's block
dnd equip d-jarrak "Voidfang Katars" --attune         # add to the character's loadout
dnd attack d-jarrak harmer-1 --weapon "voidfang katars" --distance 5
dnd attack bokun harmer-1 --weapon "fungicide blade" --distance 5 --tag unphased
dnd cast captain-dagant "Cone of Cold" --save con --damage 8d8:cold \
    --targets a,b --effect "Force of the Fall" --effect-target a
dnd use d-jarrak Shadowstep                           # spend a tracked use
dnd dawn                                              # regain per-dawn charges
```

Party loadouts live in `data/party/<id>.loadout.json`, separate from the D&D
Beyond import. Item definitions are re-read from the wiki each time the
character is added to an encounter, so editing the note changes the item. A
monster note's effects blocks are attached as traits by `wiki import`.
`DND_PARTY_DIR` points party sheets and loadouts at another folder for scratch
runs.

## Generation

```bash
dnd gen merchant --kind smithy
dnd gen town --size village
dnd gen wilderness --width 10 --height 6 --terrain forest
```

Seeded like everything else, so a location reproduces exactly from its seed
and stays stable once the party has visited it. Merchant output ends with a
"DM only" secret about the proprietor.

## For AI assistants

`CLAUDE.md` holds the operating rules (never produce a mechanical result
without the engine; positions come from the DM), and two skills hold the
working instructions:

- `.claude/skills/dnd-combat/SKILL.md`: dice, attacks, initiative, conditions,
  homebrew at the table
- `.claude/skills/dnd-campaign/SKILL.md`: the campaign wiki, note
  conventions, stat block and effects block authoring

## Tests

```bash
npm test
npm run typecheck
```

Rules are pinned by name (`"a natural 1 counts as two failures"`,
`"advantage and disadvantage cancel to a single normal roll"`), so a failure
tells you which rule broke.

## Content

Rules content derives from the System Reference Document 5.2, released by
Wizards of the Coast under CC-BY-4.0. `data/` holds your own party sheets and
monsters and is git-ignored.
