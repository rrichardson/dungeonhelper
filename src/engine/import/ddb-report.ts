/** Pure rendering of an import result for the DM to eyeball once. */

import { ABILITIES, ABILITY_NAMES, abilityModifier } from "../types.ts";
import type { DdbImport } from "./ddb.ts";

const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

export function formatImportReport(imp: DdbImport): string {
  const { combatant: c, meta, derivations: d, warnings } = imp;
  const lines: string[] = [];

  const classLine = meta.classes
    .map((k) => `${k.name}${k.subclass ? ` (${k.subclass})` : ""} ${k.level}`)
    .join(" / ");
  lines.push(`${c.name}  —  ${meta.species ?? "unknown species"} ${classLine}`);
  lines.push(`${meta.background ?? "no background"} · ${meta.ruleset} rules · D&D Beyond ${meta.ddbId ?? "?"}`);
  lines.push("");

  const hp = `${c.hp.current}/${c.hp.max}${c.hp.temp > 0 ? ` +${c.hp.temp} temp` : ""}`;
  const W = Math.max(hp.length, 6);
  lines.push(`  AC    ${String(c.ac).padEnd(W)}  ${d.armorClass.explanation}`);
  lines.push(`  HP    ${hp.padEnd(W)}  ${d.maxHitPoints.explanation}`);
  lines.push(`  Speed ${String(c.speed).padEnd(W)}  ${d.speed.explanation}`);
  lines.push(`  Prof  ${sign(c.proficiencyBonus).padEnd(W)}  ${d.proficiencyBonus.explanation}`);
  lines.push("");

  for (const a of ABILITIES) {
    const score = c.abilities[a];
    const save = c.saveProficiencies.includes(a);
    const saveMod = abilityModifier(score) + (save ? c.proficiencyBonus : 0);
    lines.push(
      `  ${ABILITY_NAMES[a].slice(0, 3).toUpperCase()} ${String(score).padStart(2)} (${sign(abilityModifier(score))})` +
        `  save ${sign(saveMod)}${save ? " ●" : "  "}   ${d.abilities[a].explanation}`,
    );
  }

  if (c.attacks && c.attacks.length > 0) {
    lines.push("");
    const width = Math.max(...c.attacks.map((a) => a.name.length));
    for (const a of c.attacks) {
      const dmg = a.damage.map((d) => `${d.expression} ${d.type}`).join(" + ");
      const reach = a.melee === false ? "ranged" : "melee";
      lines.push(
        `  ${a.name.padEnd(width)}  ${a.bonus >= 0 ? "+" : ""}${a.bonus} to hit  ${dmg}  (${reach}${a.note ? ` · ${a.note}` : ""})`,
      );
    }
  }

  const resources: string[] = [];
  if (c.spellSlots) {
    const pools = Object.entries(c.spellSlots)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([level, pool]) => `L${level} x${pool.max - pool.used}/${pool.max}`);
    if (pools.length) resources.push(`slots ${pools.join(" ")}`);
  }
  if (c.hitDice) resources.push(`hit dice ${c.hitDice.max - c.hitDice.used}/${c.hitDice.max}d${c.hitDice.size}`);
  if (c.attacksPerAction && c.attacksPerAction > 1) {
    resources.push(`${c.attacksPerAction} attacks per Attack action`);
  }
  if (resources.length) {
    lines.push("");
    lines.push(`  ${resources.join(" · ")}`);
  }

  const defenses: string[] = [];
  if (c.resistances.length) defenses.push(`resist ${c.resistances.join(", ")}`);
  if (c.immunities.length) defenses.push(`immune ${c.immunities.join(", ")}`);
  if (c.vulnerabilities.length) defenses.push(`vulnerable ${c.vulnerabilities.join(", ")}`);
  if (c.conditionImmunities.length) defenses.push(`condition-immune ${c.conditionImmunities.join(", ")}`);
  if (defenses.length) {
    lines.push("");
    lines.push(`  ${defenses.join(" · ")}`);
  }

  if (warnings.length) {
    lines.push("");
    lines.push(`  Check these ${warnings.length === 1 ? "once" : `${warnings.length} things`} against the real sheet:`);
    for (const w of warnings) lines.push(`    - ${w}`);
  }

  return lines.join("\n");
}
