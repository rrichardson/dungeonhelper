import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStatBlock, field, parseChallenge, parseSpeed, parseHitDicePool,
  parseAbilityTable, parseAttacks,
} from "./statblock.ts";

/** Heading-per-field layout. */
const headingStyle = `# Cellar Hound

**Type/Size/Alignment:** Beast (Fungal), Medium, Chaotic Evil

## Armor Class
15 (fungal chitin)

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

## Damage Vulnerabilities
Cold, Radiant

## Condition Immunities
Charmed, Frightened, Poisoned (from fungal sources)

## Challenge
4 (1,100 XP)

## Actions

**Spore Bite.** *Melee Weapon Attack:* +4 to hit, reach 5 ft., one target. *Hit:* 7 (1d8 + 2) piercing damage plus 4 (1d8) poison damage.

**Spit.** *Ranged Weapon Attack:* +4 to hit, range 30/120 ft., one target. *Hit:* 6 (1d6 + 2) acid damage.
`;

/** Inline-bold layout, the classic printed stat block. */
const inlineStyle = `# Stone Ram

**Large beast, chaotic evil**

**Armor Class** 16 (natural armor)
**Hit Points** 161 (17d10 + 68)
**Speed** 50 ft.

| STR | DEX | CON | INT | WIS | CHA |
|:---:|:---:|:---:|:---:|:---:|:---:|
| 22 (+6) | 12 (+1) | 18 (+4) | 4 (-3) | 14 (+2) | 6 (-2) |

**Saving Throws** Str +10, Con +8
**Damage Vulnerabilities** cold, radiant
**Challenge** 10 (5,900 XP)

### Actions

**Ram.** *Melee Weapon Attack:* +10 to hit, reach 5 ft., one target. *Hit:* 19 (3d8 + 6) bludgeoning damage.
`;

test("a heading-style stat block parses", () => {
  const r = parseStatBlock(headingStyle);
  assert.ok(r.ok, r.ok ? "" : r.error);
  const c = r.value.combatant;
  assert.equal(c.name, "Cellar Hound");
  assert.equal(c.id, "cellar-hound");
  assert.equal(c.ac, 15);
  assert.equal(c.hp.max, 55);
  assert.equal(c.speed, 30, "the walking speed, not the fly speed");
  assert.equal(r.value.challengeRating, 4);
  assert.deepEqual(c.hitDice, { size: 8, max: 10, used: 0 });
});

test("an inline-style stat block parses the same way", () => {
  const r = parseStatBlock(inlineStyle);
  assert.ok(r.ok, r.ok ? "" : r.error);
  const c = r.value.combatant;
  assert.equal(c.ac, 16);
  assert.equal(c.hp.max, 161);
  assert.equal(c.speed, 50);
  assert.equal(c.abilities.str, 22);
  assert.equal(r.value.challengeRating, 10);
});

test("ability scores come out of the six-column table", () => {
  const scores = parseAbilityTable(headingStyle);
  assert.deepEqual(scores, { str: 14, dex: 15, con: 13, int: 3, wis: 12, cha: 5 });
});

test("a table that is not ability scores is skipped", () => {
  const withOtherTable = `# X

| Secret | DC |
|--------|----|
| A door | 15 |

| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 8 (-1) | 10 (+0) | 12 (+1) | 14 (+2) | 16 (+3) | 18 (+4) |
`;
  assert.deepEqual(parseAbilityTable(withOtherTable), {
    str: 8, dex: 10, con: 12, int: 14, wis: 16, cha: 18,
  });
});

test("damage types and condition immunities drop their qualifiers", () => {
  const r = parseStatBlock(headingStyle);
  assert.ok(r.ok);
  const c = r.value.combatant;
  assert.deepEqual(c.immunities, ["poison", "psychic"]);
  assert.deepEqual(c.vulnerabilities, ["cold", "radiant"]);
  assert.deepEqual(
    [...c.conditionImmunities].sort(),
    ["charmed", "frightened", "poisoned"],
    "the parenthetical qualifier must not break the match",
  );
});

test("save proficiency is inferred from a bonus above the modifier", () => {
  const r = parseStatBlock(inlineStyle);
  assert.ok(r.ok);
  // STR 22 is +6; a stated +10 means proficiency. CON 18 is +4, stated +8.
  assert.deepEqual([...r.value.combatant.saveProficiencies].sort(), ["con", "str"]);
});

test("attacks carry bonus, damage, reach and range", () => {
  const r = parseStatBlock(headingStyle);
  assert.ok(r.ok);
  const attacks = r.value.combatant.attacks!;

  const bite = attacks.find((a) => a.name === "spore bite")!;
  assert.equal(bite.bonus, 4);
  assert.equal(bite.melee, true);
  assert.equal(bite.range, 5);
  assert.deepEqual(bite.damage, [
    { expression: "1d8+2", type: "piercing" },
    { expression: "1d8", type: "poison" },
  ]);

  const spit = attacks.find((a) => a.name === "spit")!;
  assert.equal(spit.melee, false);
  assert.equal(spit.range, 30);
  assert.equal(spit.longRange, 120);
});

test("conditional damage in a later sentence is not folded into every hit", () => {
  const withRider = `# Beak

| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 10 (+0) | 10 (+0) | 10 (+0) | 10 (+0) | 10 (+0) | 10 (+0) |

**Armor Class** 14
**Hit Points** 30 (4d8)
**Challenge** 2

**Axe Beak.** *Melee Weapon Attack:* +8 to hit, reach 10 ft., one target. *Hit:* 18 (4d6 + 4) slashing damage. On a critical hit, the target is bleeding and takes 7 (2d6) slashing damage at the start of each of its turns.
`;
  const r = parseStatBlock(withRider);
  assert.ok(r.ok);
  const attack = r.value.combatant.attacks![0]!;
  assert.equal(attack.damage.length, 1, "the bleed must not become part of the hit");
  assert.equal(attack.damage[0]!.expression, "4d6+4");
  assert.match(r.value.warnings.join(" "), /conditional extra damage that is not applied/);
});

test("a second stat block later in the note does not override the first", () => {
  const withMinion = `# Colossus

| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 20 (+5) | 10 (+0) | 20 (+5) | 3 (-4) | 10 (+0) | 5 (-3) |

## Armor Class
20

## Hit Points
370 (20d12 + 240)

## Challenge
21 (33,000 XP)

## Skeletal Minion

**Armor Class** 13
**Hit Points** 26 (4d8 + 8)
**Challenge** 5 (1,800 XP each)
`;
  const r = parseStatBlock(withMinion);
  assert.ok(r.ok);
  assert.equal(r.value.challengeRating, 21, "the minion's CR must not win");
  assert.equal(r.value.combatant.ac, 20);
  assert.equal(r.value.combatant.hp.max, 370);
});

test("proficiency bonus is derived from challenge rating", () => {
  const r = parseStatBlock(inlineStyle);
  assert.ok(r.ok);
  assert.equal(r.value.combatant.proficiencyBonus, 4, "CR 10 gives +4");
});

test("an explicit proficiency bonus wins over the derived one", () => {
  const r = parseStatBlock(`${headingStyle}\n## Proficiency Bonus\n+7\n`);
  assert.ok(r.ok);
  assert.equal(r.value.combatant.proficiencyBonus, 7);
});

test("unmodelled sections are named rather than silently dropped", () => {
  const withTraits = `${inlineStyle}\n### Traits\n\n**Regeneration.** It heals 10 hit points each turn.\n\n### Legendary Actions\n\nIt takes three.\n`;
  const r = parseStatBlock(withTraits);
  assert.ok(r.ok);
  const warned = r.value.warnings.join(" ");
  assert.match(warned, /"Traits" are not modelled/);
  assert.match(warned, /"Legendary Actions" are not modelled/);
});

test("a damage type the engine lacks is reported, not invented", () => {
  const odd = `# Thing

| STR | DEX | CON | INT | WIS | CHA |
|-----|-----|-----|-----|-----|-----|
| 10 (+0) | 10 (+0) | 10 (+0) | 10 (+0) | 10 (+0) | 10 (+0) |

**Armor Class** 12
**Hit Points** 20 (3d8)
**Challenge** 1

**Zap.** *Ranged Weapon Attack:* +5 to hit, range 60 ft., one target. *Hit:* 7 (2d6) sonic damage.
`;
  const r = parseStatBlock(odd);
  assert.ok(r.ok);
  assert.match(r.value.warnings.join(" "), /"sonic" damage, which the engine does not model/);
  assert.equal(r.value.combatant.attacks!.length, 0);
});

test("a note without an ability table is refused", () => {
  const r = parseStatBlock(`# Vague\n\n**Armor Class** 12\n**Hit Points** 20\n`);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /ability score table/);
});

test("missing armour class or hit points is refused", () => {
  const table = `| STR | DEX | CON | INT | WIS | CHA |\n|--|--|--|--|--|--|\n| 10 (+0) | 10 (+0) | 10 (+0) | 10 (+0) | 10 (+0) | 10 (+0) |`;
  assert.equal(parseStatBlock(`# A\n${table}\n**Hit Points** 10 (2d8)`).ok, false);
  assert.equal(parseStatBlock(`# A\n${table}\n**Armor Class** 10`).ok, false);
});

test("a note with no title needs a name supplied", () => {
  assert.equal(parseStatBlock("no heading here").ok, false);
});

// ── Frontmatter (OpenKnowledge notes carry YAML frontmatter) ─────────────

test("a frontmatter title names the creature when the note has no heading", () => {
  const note = `---\ntitle: "Stone Ram"\ndescription: A siege beast.\ntags: [monster]\n---\n\n` +
    inlineStyle.replace(/^# Stone Ram\n/, "");
  const r = parseStatBlock(note, "stone-ram-file");
  assert.ok(r.ok);
  assert.equal(r.value.combatant.name, "Stone Ram");
  assert.equal(r.value.combatant.ac, 16);
});

test("the frontmatter title wins over the body heading", () => {
  const note = `---\ntitle: Cellar Hound (Elder)\n---\n${headingStyle}`;
  const r = parseStatBlock(note);
  assert.ok(r.ok);
  assert.equal(r.value.combatant.name, "Cellar Hound (Elder)");
});

test("a YAML comment in frontmatter is not mistaken for the title heading", () => {
  const note = `---\n# managed by the wiki\ndescription: no title key\n---\n${headingStyle}`;
  const r = parseStatBlock(note);
  assert.ok(r.ok);
  assert.equal(r.value.combatant.name, "Cellar Hound");
});

test("frontmatter does not stop the stat block parsing as it would without it", () => {
  const plain = parseStatBlock(headingStyle);
  const fronted = parseStatBlock(`---\ntitle: Cellar Hound\ntags: [monster]\n---\n${headingStyle}`);
  assert.ok(plain.ok && fronted.ok);
  assert.deepEqual(fronted.value, plain.value);
});

// ── Field helpers ─────────────────────────────────────────────────────────

test("field reads both layouts", () => {
  assert.equal(field("**Armor Class** 16 (natural)", "Armor Class"), "16 (natural)");
  assert.equal(field("## Armor Class\n16 (natural)", "Armor Class"), "16 (natural)");
  assert.equal(field("nothing here", "Armor Class"), undefined);
});

test("challenge ratings may be fractions", () => {
  assert.equal(parseChallenge("1/4 (50 XP)"), 0.25);
  assert.equal(parseChallenge("1/2"), 0.5);
  assert.equal(parseChallenge("13 (10,000 XP)"), 13);
  assert.equal(parseChallenge(undefined), undefined);
});

test("speed takes the walking speed", () => {
  assert.equal(parseSpeed("30 ft., fly 50 ft."), 30);
  assert.equal(parseSpeed("0 ft., fly 30 ft. (hover)"), 0);
  assert.equal(parseSpeed("walk 25 ft."), 25);
  assert.equal(parseSpeed(undefined), undefined);
});

test("hit dice come out of the parenthetical", () => {
  assert.deepEqual(parseHitDicePool("161 (17d10 + 68)"), { max: 17, size: 10 });
  assert.equal(parseHitDicePool("161"), null);
});

test("parseAttacks ignores prose that is not an attack", () => {
  const warnings: string[] = [];
  const attacks = parseAttacks(
    "**Multiattack.** It makes two attacks.\n\n**Bite.** *Melee Weapon Attack:* +5 to hit, reach 5 ft. *Hit:* 8 (1d10 + 3) piercing damage.",
    warnings,
  );
  assert.equal(attacks.length, 1);
  assert.equal(attacks[0]!.name, "bite");
});
