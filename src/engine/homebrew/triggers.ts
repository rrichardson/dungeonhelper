/**
 * Gating and firing homebrew effects: the "may" opt-in, limited uses, and
 * triggered hooks such as critical-hit. Shared by attack and spell resolution.
 *
 * Pure. Rolls happen only through the injected Rng.
 */

import type { Rng } from "../rng.ts";
import type { Combatant } from "../types.ts";
import { effectsFor, remaining, spendUse, type LiveEffect, type MatchContext } from "./active.ts";
import { runActions } from "./run.ts";
import type { Hook } from "./types.ts";

export type Gate =
  | { readonly use: true; readonly holder: Combatant; readonly note: string | null }
  | { readonly use: false; readonly available: string | null; readonly note: string | null };

/** Whether an effect fires now: "may" needs an opt-in, uses must remain. */
export function gate(live: LiveEffect, holder: Combatant, optIn: readonly string[]): Gate {
  const wanted = optIn.map((o) => o.trim().toLowerCase());
  const named = wanted.includes(live.effect.name.toLowerCase()) || wanted.includes(live.label.toLowerCase());
  if (live.effect.may && !named) {
    const pool = live.resource !== null ? holder.resources?.[live.resource] : undefined;
    const left = pool ? ` (${remaining(pool)}/${pool.max} uses left)` : "";
    return { use: false, available: `${live.label}${left} — opt in with --effect "${live.effect.name}"`, note: null };
  }
  if (live.resource !== null) {
    const spent = spendUse(holder, live.resource);
    if (!spent.ok) return { use: false, available: null, note: `${live.label}: would apply, but ${spent.error}` };
    const pool = spent.value.resources![live.resource]!;
    return { use: true, holder: spent.value, note: `${pool.label}: ${remaining(pool)}/${pool.max} uses left` };
  }
  return { use: true, holder, note: null };
}

export interface FireOutcome {
  readonly holder: Combatant;
  readonly other: Combatant;
  readonly lines: readonly string[];
  readonly available: readonly string[];
}

/** Fire every effect of the holder on a hook that involves another creature. */
export function fire(
  hook: Hook,
  holder: Combatant,
  other: Combatant,
  ctx: MatchContext,
  opts: { readonly rng: Rng; readonly optIn: readonly string[]; readonly turnId?: string },
): FireOutcome {
  let h = holder;
  let o = other;
  const lines: string[] = [];
  const available: string[] = [];
  for (const live of effectsFor(holder, hook, ctx)) {
    const g = gate(live, h, opts.optIn);
    if (!g.use) {
      if (g.available) available.push(g.available);
      if (g.note) lines.push(g.note);
      continue;
    }
    h = g.holder;
    const ran = runActions(live.effect.actions, {
      holder: h, other: o, rng: opts.rng, label: live.label,
      ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
    });
    if (!ran.ok) {
      lines.push(`${live.label}: ${ran.error}`);
      continue;
    }
    h = ran.value.holder;
    o = ran.value.other ?? o;
    lines.push(...ran.value.lines);
    if (g.note) lines.push(g.note);
  }
  return { holder: h, other: o, lines, available };
}
