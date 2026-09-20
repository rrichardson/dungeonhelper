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
initiative with the 2024 surprise rules and stable tie-breaking.

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
