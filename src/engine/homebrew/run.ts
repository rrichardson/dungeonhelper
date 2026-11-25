/**
 * Running the actions of a triggered homebrew effect: saving throws, timed
 * conditions and grants, temporary hit points.
 *
 * Pure: randomness arrives as an injected Rng; every change is returned as a
 * new combatant plus a log line naming the effect.
 */

import type { Rng } from "../rng.ts";
import { type Result, ok, err } from "../result.ts";
import { savingThrow } from "../checks.ts";
import { describeD20 } from "../d20.ts";
import { canApply } from "../conditions.ts";
import type { Combatant } from "../types.ts";
import { contextOf, evalFormula, showFormula } from "./formula.ts";
import { addTimed, describeExpiry, expiryFor } from "./active.ts";
import type { Action } from "./types.ts";

export interface RunContext {
  /** The creature whose effect this is. */
  readonly holder: Combatant;
  /** The other creature involved (the target of the attack), if any. */
  readonly other: Combatant | null;
  readonly rng: Rng;
  /** Whose turn it is, so "until the end of X's next turn" ends on time. */
  readonly turnId?: string;
  /** "<def>: <effect>", for the log. */
  readonly label: string;
}

export interface RunOutcome {
  readonly holder: Combatant;
  readonly other: Combatant | null;
  readonly lines: readonly string[];
}

function giveTemp(c: Combatant, amount: number): { combatant: Combatant; text: string } {
  const offered = Math.max(0, Math.trunc(amount));
  if (offered <= c.hp.temp) {
    return { combatant: c, text: `${c.name} keeps ${c.hp.temp} temp HP (offered ${offered}; temp HP does not stack)` };
  }
  return { combatant: { ...c, hp: { ...c.hp, temp: offered } }, text: `${c.name} temp HP ${c.hp.temp} → ${offered}` };
}

export function runActions(actions: readonly Action[], ctx: RunContext): Result<RunOutcome, string> {
  let holder = ctx.holder;
  let other = ctx.other;
  const lines: string[] = [];
  const names = (id: string) => (id === holder.id ? holder.name : other && id === other.id ? other.name : id);
  const ids = { holder: holder.id, ...(other ? { target: other.id } : {}) };

  for (const action of actions) {
    switch (action.kind) {
      case "saving-throw": {
        if (other === null) return err(`${ctx.label}: a saving throw needs a target`);
        const dc = evalFormula(action.dc, contextOf(holder));
        if (!dc.ok) return err(`${ctx.label}: ${dc.error}`);
        const save = savingThrow(
          { creature: other, ability: action.ability, dc: dc.value, label: `${action.ability.toUpperCase()} save vs ${ctx.label}` },
          ctx.rng,
        );
        const rolled = save.autoFailed ? (save.reason ?? "automatic failure") : describeD20(save.roll!);
        lines.push(`${ctx.label}: ${other.name} ${action.ability.toUpperCase()} save ${rolled} vs DC ${dc.value} → ${save.success ? "SUCCESS" : "FAILURE"}`);
        const next = runActions(save.success ? action.onSuccess : action.onFail, { ...ctx, holder, other });
        if (!next.ok) return next;
        holder = next.value.holder;
        other = next.value.other;
        lines.push(...next.value.lines);
        break;
      }

      case "condition": {
        const recipient = action.to === "target" ? other : holder;
        if (recipient === null) return err(`${ctx.label}: no target for ${action.condition}`);
        if (!canApply(recipient, action.condition)) {
          lines.push(`${ctx.label}: ${recipient.name} is immune to ${action.condition}`);
          break;
        }
        let updated: Combatant;
        if (action.until) {
          const expires = expiryFor(action.until, ids, ctx.turnId);
          updated = addTimed(recipient, { label: ctx.label, condition: action.condition, expires });
          lines.push(`${ctx.label}: ${recipient.name} is ${action.condition} ${describeExpiry(expires, names)}`);
        } else {
          updated = { ...recipient, conditions: [...recipient.conditions, { condition: action.condition, note: `homebrew: ${ctx.label}` }] };
          lines.push(`${ctx.label}: ${recipient.name} is ${action.condition}`);
        }
        if (action.to === "target") other = updated; else holder = updated;
        break;
      }

      case "temphp": {
        const recipient = action.to === "target" ? other : holder;
        if (recipient === null) return err(`${ctx.label}: no target for temp HP`);
        const amount = evalFormula(action.amount, contextOf(holder));
        if (!amount.ok) return err(`${ctx.label}: ${amount.error}`);
        const given = giveTemp(recipient, amount.value);
        lines.push(`${ctx.label}: ${showFormula(action.amount)} = ${amount.value} → ${given.text}`);
        if (action.to === "target") other = given.combatant; else holder = given.combatant;
        break;
      }

      case "grant": {
        const recipient = action.to === "target" ? other : holder;
        if (recipient === null) return err(`${ctx.label}: no target for the grant`);
        if (!action.until) return err(`${ctx.label}: a triggered grant needs a duration`);
        const expires = expiryFor(action.until, ids, ctx.turnId);
        const updated = addTimed(recipient, { label: ctx.label, grant: action.grant, expires });
        lines.push(`${ctx.label}: ${recipient.name} gains ${describeGrant(action.grant)} ${describeExpiry(expires, names)}`);
        if (action.to === "target") other = updated; else holder = updated;
        break;
      }

      // Handled by the damage pipeline, attack and spell resolution.
      case "set-hp":
      case "scale":
      case "ignore-resistance":
      case "add-damage":
        break;
    }
  }
  return ok({ holder, other, lines });
}

export function describeGrant(g: import("./types.ts").Grant): string {
  const parts: string[] = [];
  const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  if (g.ac !== undefined) parts.push(`AC ${signed(g.ac)}`);
  if (g.speed !== undefined) parts.push(`speed ${signed(g.speed)} ft`);
  if (g.attackBonus !== undefined) parts.push(`attack ${signed(g.attackBonus)}`);
  if (g.damageBonus !== undefined) parts.push(`damage ${signed(g.damageBonus)}`);
  if (g.critRange !== undefined) parts.push(`crit on ${g.critRange}-20`);
  for (const [label, map] of [["saves", g.saveBonus], ["checks", g.checkBonus]] as const) {
    if (!map) continue;
    for (const [k, v] of Object.entries(map)) parts.push(`${k === "all" ? "all" : k.toUpperCase()} ${label} ${signed(v!)}`);
  }
  if (g.resist?.length) parts.push(`resistance to ${g.resist.join(", ")}`);
  if (g.immune?.length) parts.push(`immunity to ${g.immune.join(", ")}`);
  if (g.vulnerable?.length) parts.push(`vulnerability to ${g.vulnerable.join(", ")}`);
  if (g.resistAll) parts.push("resistance to all damage");
  return parts.join(", ");
}
