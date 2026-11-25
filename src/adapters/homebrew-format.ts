/** Rendering homebrew definitions and a creature's homebrew state. Presentation only. */

import type { Combatant } from "../engine/types.ts";
import { showFormula } from "../engine/homebrew/formula.ts";
import { describeGrant } from "../engine/homebrew/run.ts";
import { remaining, isActive, resourceKey } from "../engine/homebrew/active.ts";
import type { Action, Condition, HomebrewDef, Until, UsesSpec } from "../engine/homebrew/types.ts";

function until(u: Until | undefined): string {
  if (!u) return "";
  if (u.kind === "rounds") return ` for ${u.n} round${u.n === 1 ? "" : "s"}`;
  return ` until the end of the ${u.whose}'s next turn`;
}

function cond(prefix: string, c: Condition | undefined): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.tag) parts.push(`source tagged ${c.tag.join(" or ")}`);
  if (c.targetTag) parts.push(`target tagged ${c.targetTag.join(" or ")}`);
  if (c.type) parts.push(`damage type ${c.type.join(" or ")}`);
  if (c.weapon) parts.push(`attack with ${c.weapon.join(" or ")}`);
  return parts.length ? ` ${prefix} ${parts.join(" and ")}` : "";
}

export function describeAction(a: Action): string {
  switch (a.kind) {
    case "grant": return `${a.to === "target" ? "target gains" : "gains"} ${describeGrant(a.grant)}${until(a.until)}`;
    case "scale": return `damage × ${a.num}/${a.den}, rounded ${a.round}`;
    case "ignore-resistance": return "ignores resistance";
    case "add-damage": return `adds ${a.expression} ${a.type} damage`;
    case "saving-throw": {
      const fail = a.onFail.map(describeAction).join("; ") || "nothing";
      const success = a.onSuccess.length ? `; on success: ${a.onSuccess.map(describeAction).join("; ")}` : "";
      return `target makes a DC ${showFormula(a.dc)} ${a.ability.toUpperCase()} save; on failure: ${fail}${success}`;
    }
    case "condition": return `${a.to === "target" ? "target is" : "becomes"} ${a.condition}${until(a.until)}`;
    case "temphp": return `${a.to === "target" ? "target gains" : "gains"} temp HP = ${showFormula(a.amount)}`;
    case "set-hp": return `drops to ${showFormula(a.amount)} HP instead`;
  }
}

function uses(u: UsesSpec | undefined): string {
  if (!u) return "";
  const regain = u.regain ? ("dice" in u.regain ? `, regains ${u.regain.dice}` : `, regains ${showFormula(u.regain.formula)}`) : "";
  return ` [${showFormula(u.max)} use${showFormula(u.max) === "1" ? "" : "s"}${u.per === "never" ? "" : ` per ${u.per}`}${regain}]`;
}

const HOOK_TEXT: Record<string, string> = {
  "always": "Always",
  "incoming-damage": "When taking damage",
  "outgoing-damage": "When dealing damage",
  "critical-hit": "On a critical hit",
  "reduces-target-to-0": "When it reduces a creature to 0 HP",
  "would-drop-to-0": "When it would drop to 0 HP",
  "casts-spell": "When casting a damaging spell",
};

export function describeDef(def: HomebrewDef): string[] {
  const lines = [`${def.name} — ${def.kind}${def.attunement ? ", requires attunement" : ""}  (id ${def.id})`];
  if (def.replacesAttack) lines.push(`  takes over the sheet attack "${def.replacesAttack}", renamed "${def.name}"`);
  if (def.grantsAttack) {
    const g = def.grantsAttack;
    lines.push(`  grants attack "${g.name}": ${showFormula(g.bonus)} to hit, ${g.damage.map((d) => `${d.expression} ${d.type}`).join(" + ")}${g.melee ? "" : " (ranged)"}`);
  }
  if (def.attackTags.length) lines.push(`  its attacks are tagged: ${def.attackTags.join(", ")}`);
  if (def.creatureTags.length) lines.push(`  holder is tagged: ${def.creatureTags.join(", ")}`);
  for (const e of def.effects) {
    const when = cond("if", e.when) + cond("unless", e.unless);
    lines.push(`  • ${e.name === def.name || e.name.startsWith(`${def.name} #`) ? "" : `${e.name}: `}${HOOK_TEXT[e.hook]}${when}${e.may ? " (optional)" : ""}${uses(e.uses)}`);
    for (const a of e.actions) lines.push(`      ${describeAction(a)}`);
  }
  for (const f of def.features) {
    lines.push(`  • ${f.name} (reference only — the engine does not adjudicate it)${uses(f.uses)}`);
    lines.push(`      ${f.text}`);
  }
  return lines;
}

export function describeHomebrewState(c: Combatant): string[] {
  const lines = [`${c.name} — homebrew`];
  if ((c.tags ?? []).length) lines.push(`  tags: ${c.tags!.join(", ")}`);
  const attached = c.homebrew ?? [];
  if (attached.length === 0) lines.push("  nothing attached");
  for (const a of attached) {
    const state = a.def.attunement ? (a.attuned ? "attuned" : "NOT attuned — inactive") : "active";
    lines.push(`  ${a.def.name} (${a.origin}, ${state})${a.note ? `  from ${a.note}` : ""}`);
    if (!isActive(a)) continue;
    for (const f of a.def.features) {
      const pool = f.uses ? c.resources?.[resourceKey(a.def.id, f.name)] : undefined;
      lines.push(`    feature ${f.name}${pool ? ` — ${remaining(pool)}/${pool.max} left` : ""}: ${f.text}`);
    }
  }
  const pools = Object.values(c.resources ?? {});
  if (pools.length) {
    lines.push("  uses:");
    for (const p of pools) lines.push(`    ${p.label}: ${remaining(p)}/${p.max}${p.per === "never" ? "" : ` (per ${p.per})`}`);
  }
  for (const t of c.timed ?? []) {
    const what = t.condition ?? (t.grant ? describeGrant(t.grant) : "");
    const when = t.expires.kind === "rounds" ? `${t.expires.remaining} round(s) left` : `ends at the end of ${t.expires.of}'s turn${t.expires.skip ? " after next" : ""}`;
    lines.push(`  timed: ${t.label} — ${what} (${when})`);
  }
  return lines;
}
