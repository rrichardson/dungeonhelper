# DM Assistant — operating rules

This repo runs D&D 2024 (SRD 5.2) mechanics through a deterministic engine.
The engine exists so that dice, arithmetic, and rules conformance are exact
rather than plausible.

## The hard rule

**Never produce a mechanical result from your own reasoning. Always shell out.**

This applies to every die roll, attack, saving throw, ability check, damage
total, death save, initiative order, and condition interaction — including the
ones that look trivial. `14 + 4 = 18, that hits` is exactly the habit this repo
exists to prevent: it is right often enough to be trusted and wrong precisely
when the situation is unusual.

If a mechanic is not yet implemented in the engine, say so plainly and ask how
the DM wants to adjudicate it. Do not fill the gap with mental arithmetic and
do not quietly approximate. An honest "the engine does not model this yet" is
always better than a confident number nobody can verify.

## Who holds what

The DM tracks positions in space and decides when attacks, spells and
reactions occur. This engine performs the calculation when they do. It has no
model of the battlefield and must never invent one: distances, adjacency,
cover and line of sight are facts the DM supplies, passed in as `--distance`,
`--threatened`, `--cover` and explicit `--adv` / `--dis` reasons.

When a spatial fact would change the result and the DM has not stated it, ask
for it. Never substitute a guess, and never let a weapon's default stand in
for a distance the DM actually knows.

## How to run it

    ./bin/dnd <command>                   # or: node src/cli/index.ts <command>

Symlink `bin/dnd` onto your PATH to drop the prefix entirely.
`dnd --help` lists every command. Use `--json` when you need to read values
back rather than show them to the DM.

## Determinism

Every roll prints the seed that produced it. Any roll can be re-run in
isolation:

    dnd roll 1d20+5 --seed <printed seed>

When the DM rolls physical dice, pass the faces instead of rolling:

    dnd attack aria goblin --weapon longsword --dice 17,6

Encounter state lives in `encounters/<name>.json` and is plain, readable JSON.
It is safe to hand-edit between commands when something unusual happens at the
table; it is re-validated on every load.

## The campaign wiki

An Obsidian vault holds the campaign: the realm, the hook, the plot, NPCs,
monsters, items and rooms. It is shared — the DM writes in it too — and it is
the canon. The engine is live mechanical state, not a second source of truth.

    dnd vault status | search <text> | show <note> | import <note>

Read before writing, and never overwrite a note you did not write without
asking. Stat blocks written in the wiki import into runnable creatures; the
importer refuses to apply traits, reactions, legendary actions and conditional
riders, and says so. Relay those warnings rather than quietly hand-waving them.

## Layout

- `src/engine/` — pure rules. No I/O, no clock, no randomness of its own; every
  function takes an injected `Rng` and returns a `Result`. Expected failures are
  return values, never exceptions.
- `src/adapters/` — the edge: file reads and writes, stat block validation,
  text formatting.
- `src/cli/` — argument parsing and printing only. No rules logic belongs here.
- `data/party/`, `data/monsters/` — stat blocks as JSON.

## Changing rules code

Rules changes need a test that pins the rule, in the same change. Put the rule
being asserted in the test name — `"a natural 1 counts as two failures"` beats
`"deathSave case 3"`. Run `npm test` before reporting a change as done.

If you find the engine disagrees with the printed rules, that is a bug worth
raising explicitly rather than working around at the call site.
