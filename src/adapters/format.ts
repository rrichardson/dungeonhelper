/** Rendering outcomes as text for the console. Presentation only — no rules. */

import type { DiceResult } from "../engine/dice.ts";
import { describeD20 } from "../engine/d20.ts";
import type { AttackReport, CombatantStatus, EncounterState, LogLine } from "../engine/encounter.ts";
import type { CheckOutcome } from "../engine/checks.ts";
import type { DeathSaveOutcome } from "../engine/death.ts";
import type { InitiativeEntry } from "../engine/initiative.ts";
import type { Combatant } from "../engine/types.ts";

/** "1d6[3] +2 = 5" — every die visible so the arithmetic can be checked. */
export function describeDice(result: DiceResult): string {
  const parts = result.terms.map((term) => {
    const sign = term.sign === 1 ? "" : "-";
    if (term.rolls.length === 0) return `${sign}${Math.abs(term.total)}`;
    const faces = term.rolls
      .map((r) => (r.kept ? `${r.value}` : `~~${r.value}~~`))
      .join(",");
    return `${sign}${term.notation}[${faces}]`;
  });
  return `${parts.join(" ")} = ${result.total}`;
}

export function hpBar(c: Combatant): string {
  const temp = c.hp.temp > 0 ? ` +${c.hp.temp} temp` : "";
  return `${c.hp.current}/${c.hp.max}${temp}`;
}

function conditionList(c: Combatant): string {
  const names: string[] = c.conditions.map((a) => a.condition);
  if (c.exhaustion > 0) names.push(`exhaustion ${c.exhaustion}`);
  if (c.concentration) names.push(`concentrating: ${c.concentration.spell}`);
  return names.length > 0 ? names.join(", ") : "—";
}

export function formatAttack(report: AttackReport, state: EncounterState): string {
  const o = report.outcome;
  const attacker = state.combatants[o.attackerId]?.name ?? o.attackerId;
  const target = state.combatants[o.targetId];
  const targetName = target?.name ?? o.targetId;

  const lines: string[] = [];
  lines.push(`${attacker} → ${o.weapon} → ${targetName} (AC ${o.effectiveAc})`);

  const verdict = o.hit
    ? o.critical
      ? `CRIT (${o.criticalReason})`
      : "HIT"
    : o.automatic === "miss"
      ? "MISS (natural 1)"
      : "MISS";
  lines.push(`  ${describeD20(o.roll)} vs AC ${o.effectiveAc} → ${verdict}`);

  for (const note of o.notes) lines.push(`  ${note}`);

  if (o.hit && o.damage) {
    for (const { spec, result } of o.damageRolls) {
      lines.push(`  dmg: ${describeDice(result)} ${spec.type}`);
    }
    for (const p of o.damage.packets) {
      if (p.adjustment !== "normal") {
        lines.push(`  ${p.type} ${p.adjustment}: ${p.before} → ${p.after}`);
      }
    }
    if (o.damage.tempAbsorbed > 0) lines.push(`  ${o.damage.tempAbsorbed} absorbed by temp HP`);
    lines.push(`  ${targetName}: ${o.damage.hpBefore} → ${o.damage.hpAfter} HP (−${o.damage.adjustedTotal})`);
    for (const note of o.damage.notes) lines.push(`  ! ${note}`);
    if (o.damage.droppedToZero) lines.push(`  ! ${targetName} drops to 0 and is unconscious`);
    if (o.damage.died) lines.push(`  ! ${targetName} dies`);
  }

  if (report.concentration) {
    const c = report.concentration;
    lines.push(
      `  ${c.label}: ${c.roll ? c.roll.total : c.reason} → ${c.success ? "holds" : "BROKEN"}`,
    );
  }

  lines.push(`  (seed ${report.seed})`);
  return lines.join("\n");
}

export function formatCheck(outcome: CheckOutcome, name: string, seed: string): string {
  const detail = outcome.autoFailed
    ? outcome.reason ?? "automatic failure"
    : describeD20(outcome.roll!);
  const verdict = outcome.success ? "SUCCESS" : "FAILURE";
  const margin =
    outcome.margin === null ? "" : ` (${outcome.margin >= 0 ? "+" : ""}${outcome.margin})`;
  return [
    `${name} — ${outcome.label} vs DC ${outcome.dc}`,
    `  ${detail} → ${verdict}${margin}`,
    `  (seed ${seed})`,
  ].join("\n");
}

export function formatDeathSave(outcome: DeathSaveOutcome, name: string, seed: string): string {
  const s = outcome.combatant.deathSaves;
  const lines = [
    `${name} — death save`,
    `  ${describeD20(outcome.roll)} vs DC 10 → ${outcome.success ? "SUCCESS" : "FAILURE"}`,
    `  successes ${s.successes}/3, failures ${s.failures}/3`,
  ];
  for (const note of outcome.notes) lines.push(`  ! ${note}`);
  lines.push(`  (seed ${seed})`);
  return lines.join("\n");
}

export function formatInitiative(entries: readonly InitiativeEntry[]): string {
  const width = Math.max(4, ...entries.map((e) => e.name.length));
  return entries
    .map((e, i) => `  ${String(i + 1).padStart(2)}. ${e.name.padEnd(width)}  ${String(e.total).padStart(3)}`)
    .join("\n");
}

export function formatStatus(rows: readonly CombatantStatus[], state: EncounterState): string {
  if (rows.length === 0) return "No combatants yet.";

  const header = state.started
    ? `${state.name} — round ${state.round}`
    : `${state.name} — not started`;

  const nameWidth = Math.max(6, ...rows.map((r) => r.combatant.name.length));
  const hpWidth = Math.max(5, ...rows.map((r) => hpBar(r.combatant).length));

  const body = rows.map((r) => {
    const c = r.combatant;
    const marker = r.isCurrentTurn ? "▶" : " ";
    const init = r.initiative === null ? " --" : String(r.initiative).padStart(3);
    const dead = c.deathSaves.failures >= 3 || (c.hp.current <= 0 && !c.isPlayer);
    const state_ = dead ? "DEAD" : c.hp.current <= 0 ? (c.stable ? "STABLE" : "DYING") : "";
    const saves =
      c.hp.current <= 0 && c.isPlayer && !dead
        ? ` [${"●".repeat(c.deathSaves.successes)}${"○".repeat(3 - c.deathSaves.successes)}/${"✕".repeat(c.deathSaves.failures)}${"○".repeat(3 - c.deathSaves.failures)}]`
        : "";
    return (
      `${marker} ${init}  ${c.name.padEnd(nameWidth)}  AC ${String(c.ac).padStart(2)}  ` +
      `${hpBar(c).padEnd(hpWidth)}  spd ${String(r.speed).padStart(2)}  ${conditionList(c)}` +
      `${state_ ? `  ${state_}` : ""}${saves}`
    );
  });

  return [header, ...body].join("\n");
}

export function formatLog(log: readonly LogLine[], limit: number): string {
  const slice = log.slice(-limit);
  if (slice.length === 0) return "(no entries yet)";
  return slice
    .map((l) => `  [r${l.round}] ${l.text}${l.seed ? `  (${l.seed})` : ""}`)
    .join("\n");
}
