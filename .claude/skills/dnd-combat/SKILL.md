---
name: dnd-combat
description: Run D&D 2024 combat and any mechanical resolution through the deterministic rules engine — dice rolls, attacks, damage, saving throws, ability checks, initiative, conditions, concentration, death saves, exhaustion. Use whenever a die would be rolled or a rule adjudicated at the table, including single one-off rolls outside combat.
---

# Running mechanics

Every mechanical result comes from the CLI. Never compute one yourself — not a
to-hit total, not a damage sum, not "that obviously hits". The engine exists so
the arithmetic is verifiable; doing it in your head silently discards that.

Run from the repo root:

    node src/cli/index.ts <command>

## Starting an encounter

    dnd new "Goblin Ambush"           # optional: --seed <seed> to replay a session
    dnd sheets                        # what stat blocks exist
    dnd add aria                      # add a party member from data/party/
    dnd add goblin --count 3          # adds goblin-1, goblin-2, goblin-3
    dnd init                          # roll initiative for everyone
    dnd init --fixed aria=20          # place someone on a chosen count
    dnd start                         # begin round 1
    dnd next                          # advance the turn
    dnd status                        # the board: HP, conditions, whose turn
    dnd log --limit 20                # what has happened

## Attacks

    dnd attack <attacker> <target> --weapon longsword
    dnd attack goblin-1 aria --bonus 4 --damage "1d6+2:slashing"
    dnd attack aria ogre --weapon longbow --dis "long range"
    dnd attack aria ogre --weapon longsword --adv "flanking" --cover half

`--weapon` reads the attack off the stat block. Otherwise give `--bonus` and
one or more `--damage EXPR:TYPE`. Add `--crit-range 19` for an expanded crit
range, `--ranged` to force a non-melee attack, `--force` to override a refusal.

Advantage and disadvantage from conditions are applied automatically from the
state of both combatants. Only pass `--adv` / `--dis` for circumstances the
engine cannot know: cover, spells, terrain, features, DM rulings. Give a
reason string — it appears in the log.

## Spells with saving throws

Area and save-based spells go through `cast`, not `damage`:

    dnd cast brann "Fireball" --save dex --damage "8d6:fire" \
        --targets goblin-1,goblin-2,ogre --slot 3
    dnd cast wizard "Hold Person" --save wis --target ogre --on-success none
    dnd cast brann "Spirit Guardians" --save wis --damage "3d8:radiant" \
        --target ogre --slot 3 --concentrate

The DC comes from the caster's sheet when they have a spellcasting ability;
pass `--dc N` otherwise. `--on-success` is `half` by default, `none` for
spells a save avoids entirely.

Damage is rolled **once** for the whole area and the same total applies to
every target — that is the rule, and re-rolling per creature is wrong. Never
run `cast` once per target to simulate an area effect.

## Other resolution

    dnd damage goblin-1 12:fire 4:piercing    # direct damage, several types
    dnd heal aria 9
    dnd temphp aria 5
    dnd save aria dex 15                       # add --proficient to force it
    dnd check aria str 12 --proficient
    dnd deathsave aria
    dnd stabilize aria
    dnd condition goblin-2 prone               # --off to remove
    dnd condition aria grappled --source ogre  # source matters for grappled
    dnd exhaustion aria 2
    dnd concentrate brann "Spirit Guardians"   # --off to drop it
    dnd roll 2d6+3                             # a standalone roll
    dnd reaction aria                          # spend this round's reaction

Multiple attacks in one turn — Extra Attack, a monster's Multiattack — use
`--times`, which rolls each swing separately and stops if the target falls:

    dnd attack ogre aria --weapon greatclub --times 2

## Resources and rests

    dnd slots brann                    # show remaining spell slots
    dnd slots brann --use 3            # spend one without casting
    dnd slots brann --restore all
    dnd rest short aria --hit-dice 2   # spend hit dice to heal
    dnd rest long                      # every player character

A long rest restores hit points and slots, returns half the hit dice, and
removes one level of exhaustion. Reactions refresh automatically at the start
of each creature's own turn.

## Imported characters

Party sheets can come from D&D Beyond (the sheet's privacy must be Public):

    node src/cli/import-ddb.ts <id or url>      # writes data/party/<name>.json
    node src/cli/import-ddb.ts <id> --dry-run   # show the report, write nothing

The import report shows the arithmetic behind every derived number. Read its
warnings aloud to the DM the first time a character is imported — they mark
exactly what the importer could not determine and chose not to guess.

Each attack carries a `note`. **Read it before rolling.** Some attacks are not
one roll:

- Eldritch Blast fires multiple beams (2 at level 5, 3 at 11, 4 at 17), each
  its own attack roll against possibly different targets. Run the command once
  per beam; do not multiply one result.
- Damage marked "scaling not applied" means the cantrip's dice were not scaled
  automatically — ask the DM for the correct dice rather than assuming.
- Attacks marked "level N slot" consume a spell slot. The engine does not
  track slots yet; the DM does.

## Physical dice

When the DM rolls real dice, pass the faces in order instead of rolling:

    dnd attack aria goblin-1 --weapon longsword --dice 17,6
    dnd roll 4d6kh3 --dice 5,3,6,2

The count must match exactly what the expression needs, or the command fails
rather than inventing the rest.

## Reading results

Output shows every die face, every modifier with its source, and the seed:

    Aria → longsword → Goblin 1 (AC 15)
      d20: [10] +6 attack bonus = 16 vs AC 15 → HIT
      dmg: 1d8[8] +4 = 12 slashing
      Goblin 1: 7 → 0 HP (−12)
      (seed table1#4)

Relay what happened in narrative terms, but keep the numbers exactly as the
engine reported them. Use `--json` when you need to read values programmatically.

Any roll can be re-run: `dnd roll 1d20+6 --seed table1#4`.

## What the engine already knows

Do not re-derive these by hand — they are applied automatically:

- advantage/disadvantage from conditions on either combatant, and the rule that
  any advantage plus any disadvantage cancels to a flat roll
- prone giving advantage in melee and disadvantage at range
- grappled penalising attacks only against creatures other than the grappler
- automatic crits on paralyzed or unconscious targets within 5 feet
- criticals doubling dice but not flat modifiers
- resistance, immunity, vulnerability, and temp HP absorption order
- massive-damage instant death, and death save failures from damage at 0 HP
- concentration DC (half damage, minimum 10) rolled automatically after damage
- exhaustion as −2 per level on all d20 tests and −5 ft speed per level
- unconscious implying both prone and incapacitated

## Generating content

    dnd gen merchant --kind smithy       # shop, proprietor, priced stock
    dnd gen town --size village          # settlement, problem, rumours, trades
    dnd gen wilderness --width 10 --height 6 --terrain forest

Generation is seeded like everything else: the same seed reproduces the same
shop or map, so a location stays stable once the party has visited it. Record
the seed with the location.

Merchant output ends with a "DM only" line — a secret about the proprietor.
Do not read that one aloud.

## When the engine does not model something

Say so and ask the DM how they want to rule it. Do not approximate with mental
arithmetic. Spell effects beyond damage, movement, cover geometry, and most
class features are not modelled yet.
