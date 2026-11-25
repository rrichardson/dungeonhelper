/**
 * Attaching homebrew to a creature, and taking it off again.
 *
 * Pure. Enforces the three-item attunement limit, and does the attack
 * bookkeeping for weapons: a weapon either takes over an attack already on
 * the sheet (renaming it to the weapon) or adds a new one.
 */

import { type Result, ok, err } from "../result.ts";
import type { Combatant, WeaponAttack } from "../types.ts";
import { contextOf, evalFormula, substituteNames } from "./formula.ts";
import { initResources, resourceKey } from "./active.ts";
import type { Attached, HomebrewDef } from "./types.ts";

export const MAX_ATTUNEMENT = 3;

export interface AttachRequest {
  readonly def: HomebrewDef;
  readonly source: unknown;
  readonly attuned: boolean;
  readonly origin: Attached["origin"];
  readonly note?: string;
  /** Override: the sheet attack this weapon takes over (loadout "as-attack"). */
  readonly asAttack?: string;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function attunedCount(c: Combatant): number {
  return (c.homebrew ?? []).filter((a) => a.def.attunement && a.attuned).length;
}

export function attach(c: Combatant, req: AttachRequest): Result<Combatant, string> {
  const { def } = req;
  if ((c.homebrew ?? []).some((a) => a.def.id === def.id)) {
    return err(`${c.name} already has ${def.name}`);
  }
  const attuned = def.attunement && req.attuned;
  if (attuned && attunedCount(c) >= MAX_ATTUNEMENT) {
    const names = (c.homebrew ?? []).filter((a) => a.def.attunement && a.attuned).map((a) => a.def.name).join(", ");
    return err(`${c.name} is already attuned to ${MAX_ATTUNEMENT} items (${names}); unattune one first`);
  }

  let attacks: WeaponAttack[] = [...(c.attacks ?? [])];
  let replaced: string | undefined;
  const takeOver = req.asAttack ?? def.replacesAttack;

  if (def.kind === "weapon" && takeOver !== undefined) {
    const i = attacks.findIndex((a) => same(a.name, takeOver));
    if (i === -1) {
      const known = attacks.map((a) => a.name).join(", ") || "none";
      return err(`${def.name} takes over the attack "${takeOver}", which ${c.name} does not have (has: ${known})`);
    }
    replaced = attacks[i]!.name;
    if (attacks.some((a, j) => j !== i && same(a.name, def.name))) {
      return err(`${c.name} already has an attack named "${def.name}"`);
    }
    attacks[i] = { ...attacks[i]!, name: def.name };
  } else if (def.kind === "weapon" && def.grantsAttack) {
    const g = def.grantsAttack;
    if (attacks.some((a) => same(a.name, g.name))) return err(`${c.name} already has an attack named "${g.name}"`);
    const ctx = contextOf(c);
    const bonus = evalFormula(g.bonus, ctx);
    if (!bonus.ok) return err(`${def.name}: attack bonus: ${bonus.error}`);
    const damage = [];
    for (const d of g.damage) {
      const expr = substituteNames(d.expression, ctx);
      if (!expr.ok) return err(`${def.name}: damage: ${expr.error}`);
      damage.push({ expression: expr.value, type: d.type });
    }
    attacks = [...attacks, {
      name: g.name,
      bonus: bonus.value,
      damage,
      melee: g.melee,
      ...(g.range !== undefined ? { range: g.range } : {}),
      ...(g.longRange !== undefined ? { longRange: g.longRange } : {}),
      note: `granted by ${def.name}`,
    }];
  }

  const entry: Attached = {
    def,
    source: req.source,
    attuned,
    origin: req.origin,
    ...(req.note !== undefined ? { note: req.note } : {}),
    ...(req.asAttack !== undefined ? { asAttack: req.asAttack } : {}),
    ...(replaced !== undefined ? { replaced } : {}),
  };
  return initResources({ ...c, attacks, homebrew: [...(c.homebrew ?? []), entry] });
}

export function detach(c: Combatant, ref: string): Result<Combatant, string> {
  const list = c.homebrew ?? [];
  const i = list.findIndex((a) => a.def.id === ref || same(a.def.name, ref));
  if (i === -1) {
    const known = list.map((a) => a.def.name).join(", ") || "none";
    return err(`${c.name} has no homebrew "${ref}" (has: ${known})`);
  }
  const a = list[i]!;
  let attacks = [...(c.attacks ?? [])];
  if (a.replaced !== undefined) {
    attacks = attacks.map((w) => (same(w.name, a.def.name) ? { ...w, name: a.replaced! } : w));
  } else if (a.def.kind === "weapon" && a.def.grantsAttack) {
    attacks = attacks.filter((w) => !same(w.name, a.def.grantsAttack!.name));
  }
  const prefix = `${a.def.id}/`;
  const resources = Object.fromEntries(Object.entries(c.resources ?? {}).filter(([k]) => !k.startsWith(prefix)));
  return ok({
    ...c,
    attacks,
    homebrew: [...list.slice(0, i), ...list.slice(i + 1)],
    resources,
    timed: (c.timed ?? []).filter((t) => !t.label.startsWith(a.def.name)),
  });
}

/** Change attunement on something already attached. */
export function setAttuned(c: Combatant, ref: string, attuned: boolean): Result<Combatant, string> {
  const list = c.homebrew ?? [];
  const i = list.findIndex((a) => a.def.id === ref || same(a.def.name, ref));
  if (i === -1) return err(`${c.name} has no homebrew "${ref}"`);
  const a = list[i]!;
  if (!a.def.attunement) return err(`${a.def.name} does not require attunement`);
  if (attuned && !a.attuned && attunedCount(c) >= MAX_ATTUNEMENT) {
    return err(`${c.name} is already attuned to ${MAX_ATTUNEMENT} items`);
  }
  const next = [...list];
  next[i] = { ...a, attuned };
  return ok({ ...c, homebrew: next });
}

export { resourceKey };
