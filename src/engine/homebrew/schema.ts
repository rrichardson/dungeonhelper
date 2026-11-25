/**
 * Validating an authored homebrew definition into a HomebrewDef.
 *
 * Pure and total. Every rejection names the path of the offending field and
 * what was expected, so the DM can fix the note without guessing.
 */

import { type Result, ok, err } from "../result.ts";
import {
  ABILITIES, CONDITION_NAMES, DAMAGE_TYPES,
  type Ability, type ConditionName, type DamageType,
} from "../types.ts";
import { parseDice } from "../dice.ts";
import { parseFormula, namesInDice, type Formula } from "./formula.ts";
import {
  DEF_KINDS, HOOKS, REST_PERIODS,
  type Action, type AttackSpec, type Condition, type DefKind, type Effect, type Feature,
  type Grant, type HomebrewDef, type Hook, type Target, type Until, type UsesSpec,
} from "./types.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function slugify(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "homebrew" : cleaned;
}

function unknownKeys(o: Obj, allowed: readonly string[], path: string): Result<true, string> {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) return err(`${path}: unknown key "${k}" (allowed: ${allowed.join(", ")})`);
  }
  return ok(true);
}

function stringList(v: unknown, path: string): Result<string[], string> {
  if (v === undefined || v === null) return ok([]);
  const list = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const [i, item] of list.entries()) {
    if (typeof item !== "string" || item.trim() === "") return err(`${path}[${i}]: expected text`);
    out.push(item.trim().toLowerCase());
  }
  return ok(out);
}

function typeList(v: unknown, path: string): Result<DamageType[], string> {
  const list = stringList(v, path);
  if (!list.ok) return list;
  for (const t of list.value) {
    if (!DAMAGE_TYPES.includes(t as DamageType)) {
      return err(`${path}: unknown damage type "${t}" (expected one of ${DAMAGE_TYPES.join(", ")})`);
    }
  }
  return ok(list.value as DamageType[]);
}

function formula(v: unknown, path: string): Result<Formula, string> {
  if (typeof v !== "number" && typeof v !== "string") return err(`${path}: expected a number or formula`);
  const parsed = parseFormula(v);
  if (!parsed.ok) return err(`${path}: ${parsed.error}`);
  return parsed;
}

function integer(v: unknown, path: string): Result<number, string> {
  if (typeof v !== "number" || !Number.isInteger(v)) return err(`${path}: expected a whole number`);
  return ok(v);
}

/** "3d8:radiant" or "2d6 + mod(str):slashing" — the CLI's EXPR:TYPE form. */
function damageSpec(v: unknown, path: string): Result<{ expression: string; type: DamageType }, string> {
  if (typeof v !== "string") return err(`${path}: expected "EXPR:type", e.g. "3d8:radiant"`);
  const at = v.lastIndexOf(":");
  if (at === -1) return err(`${path}: "${v}" needs a damage type, e.g. "3d8:radiant"`);
  const expression = v.slice(0, at).trim();
  const type = v.slice(at + 1).trim().toLowerCase();
  if (!DAMAGE_TYPES.includes(type as DamageType)) {
    return err(`${path}: unknown damage type "${type}" (expected one of ${DAMAGE_TYPES.join(", ")})`);
  }
  // Names are replaced by numbers before rolling; check the shape with zeros.
  let probe = expression;
  for (const name of namesInDice(expression)) {
    const f = parseFormula(name);
    if (!f.ok) return err(`${path}: ${f.error}`);
    probe = probe.replace(name, "0");
  }
  const dice = parseDice(probe.replace(/\s+/g, ""));
  if (!dice.ok) return err(`${path}: "${expression}": ${dice.error}`);
  return ok({ expression, type: type as DamageType });
}

function bonusMap(v: unknown, path: string): Result<Partial<Record<Ability | "all", number>>, string> {
  if (typeof v === "number") return ok({ all: v });
  if (!isObj(v)) return err(`${path}: expected a number (all) or a map like {dex: 2}`);
  const out: Partial<Record<Ability | "all", number>> = {};
  for (const [k, n] of Object.entries(v)) {
    if (k !== "all" && !ABILITIES.includes(k as Ability)) {
      return err(`${path}: unknown ability "${k}" (expected all, ${ABILITIES.join(", ")})`);
    }
    const i = integer(n, `${path}.${k}`);
    if (!i.ok) return i;
    out[k as Ability | "all"] = i.value;
  }
  return ok(out);
}

function condition(v: unknown, path: string): Result<Condition | undefined, string> {
  if (v === undefined || v === null) return ok(undefined);
  if (!isObj(v)) return err(`${path}: expected a map like {type: cold} or {tag: unphased}`);
  const keys = unknownKeys(v, ["tag", "target-tag", "type", "weapon"], path);
  if (!keys.ok) return keys;
  const tag = stringList(v["tag"], `${path}.tag`);
  if (!tag.ok) return tag;
  const targetTag = stringList(v["target-tag"], `${path}.target-tag`);
  if (!targetTag.ok) return targetTag;
  const type = typeList(v["type"], `${path}.type`);
  if (!type.ok) return type;
  const weapon = stringList(v["weapon"], `${path}.weapon`);
  if (!weapon.ok) return weapon;
  return ok({
    ...(tag.value.length ? { tag: tag.value } : {}),
    ...(targetTag.value.length ? { targetTag: targetTag.value } : {}),
    ...(type.value.length ? { type: type.value } : {}),
    ...(weapon.value.length ? { weapon: weapon.value } : {}),
  });
}

function until(v: unknown, path: string): Result<Until | undefined, string> {
  if (v === undefined || v === null) return ok(undefined);
  if (v === "end-of-holder-next-turn") return ok({ kind: "end-of-turn", whose: "holder" });
  if (v === "end-of-target-next-turn") return ok({ kind: "end-of-turn", whose: "target" });
  if (typeof v === "string") {
    const m = /^(\d+)\s+rounds?$/.exec(v.trim());
    if (m) return ok({ kind: "rounds", n: Number(m[1]) });
  }
  if (isObj(v) && Object.keys(v).length === 1 && "rounds" in v) {
    const n = integer(v["rounds"], `${path}.rounds`);
    if (!n.ok) return n;
    if (n.value < 1) return err(`${path}.rounds: must be at least 1`);
    return ok({ kind: "rounds", n: n.value });
  }
  return err(`${path}: expected end-of-holder-next-turn, end-of-target-next-turn, or {rounds: N}`);
}

function target(v: unknown, path: string, fallback: Target): Result<Target, string> {
  if (v === undefined) return ok(fallback);
  if (v === "self" || v === "target") return ok(v);
  return err(`${path}: expected self or target`);
}

const GRANT_KEYS = [
  "ac", "speed", "save-bonus", "check-bonus", "attack-bonus", "damage-bonus",
  "crit-range", "resist", "immune", "vulnerable", "resist-all",
] as const;

function grant(o: Obj, path: string): Result<Grant, string> {
  const g: { -readonly [K in keyof Grant]: Grant[K] } = {};
  for (const key of ["ac", "speed", "attack-bonus", "damage-bonus", "crit-range"] as const) {
    if (o[key] === undefined) continue;
    const n = integer(o[key], `${path}.${key}`);
    if (!n.ok) return n;
    if (key === "ac") g.ac = n.value;
    if (key === "speed") g.speed = n.value;
    if (key === "attack-bonus") g.attackBonus = n.value;
    if (key === "damage-bonus") g.damageBonus = n.value;
    if (key === "crit-range") {
      if (n.value < 2 || n.value > 20) return err(`${path}.crit-range: must be 2-20`);
      g.critRange = n.value;
    }
  }
  if (o["save-bonus"] !== undefined) {
    const b = bonusMap(o["save-bonus"], `${path}.save-bonus`);
    if (!b.ok) return b;
    g.saveBonus = b.value;
  }
  if (o["check-bonus"] !== undefined) {
    const b = bonusMap(o["check-bonus"], `${path}.check-bonus`);
    if (!b.ok) return b;
    g.checkBonus = b.value;
  }
  for (const key of ["resist", "immune", "vulnerable"] as const) {
    if (o[key] === undefined) continue;
    const list = typeList(o[key], `${path}.${key}`);
    if (!list.ok) return list;
    g[key] = list.value;
  }
  if (o["resist-all"] !== undefined) {
    if (o["resist-all"] !== true) return err(`${path}.resist-all: expected true`);
    g.resistAll = true;
  }
  return ok(g);
}

/** Which actions each hook may carry. */
const ALLOWED: Record<Hook, readonly Action["kind"][]> = {
  "always": ["grant"],
  "incoming-damage": ["scale"],
  "outgoing-damage": ["ignore-resistance", "add-damage"],
  "critical-hit": ["saving-throw", "condition", "temphp", "grant"],
  "reduces-target-to-0": ["condition", "temphp", "grant"],
  "would-drop-to-0": ["set-hp", "grant", "condition", "temphp"],
  "casts-spell": ["add-damage"],
};

/** Hooks where "target" names another creature. */
const HAS_TARGET: readonly Hook[] = ["critical-hit", "reduces-target-to-0"];

function action(v: unknown, path: string, hook: Hook): Result<Action, string> {
  if (!isObj(v)) return err(`${path}: expected an action map, e.g. {ignore: resistance}`);

  const allowedKind = (kind: Action["kind"]): Result<true, string> =>
    ALLOWED[hook].includes(kind)
      ? ok(true)
      : err(`${path}: "${kind}" cannot be used with on: ${hook} (allowed: ${ALLOWED[hook].join(", ")})`);

  const toFallback: Target = HAS_TARGET.includes(hook) ? "target" : "self";
  const checkTo = (t: Target): Result<true, string> =>
    t === "target" && !HAS_TARGET.includes(hook)
      ? err(`${path}.to: there is no other creature to target with on: ${hook}`)
      : ok(true);

  if ("scale" in v) {
    const keys = unknownKeys(v, ["scale", "round"], path);
    if (!keys.ok) return keys;
    const a = allowedKind("scale");
    if (!a.ok) return a;
    const m = typeof v["scale"] === "string" ? /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(v["scale"]) : null;
    const num = m ? Number(m[1]) : typeof v["scale"] === "number" ? v["scale"] : NaN;
    const den = m ? Number(m[2]) : 1;
    if (!Number.isInteger(num) || !Number.isInteger(den) || den === 0 || num < 0) {
      return err(`${path}.scale: expected a fraction like 1/4 or a whole number like 2`);
    }
    const round = v["round"] ?? "down";
    if (round !== "down" && round !== "up" && round !== "nearest") {
      return err(`${path}.round: expected down, up or nearest`);
    }
    return ok({ kind: "scale", num, den, round });
  }

  if ("ignore" in v) {
    const keys = unknownKeys(v, ["ignore"], path);
    if (!keys.ok) return keys;
    const a = allowedKind("ignore-resistance");
    if (!a.ok) return a;
    if (v["ignore"] !== "resistance") return err(`${path}.ignore: only "resistance" can be ignored`);
    return ok({ kind: "ignore-resistance" });
  }

  if ("add-damage" in v) {
    const keys = unknownKeys(v, ["add-damage"], path);
    if (!keys.ok) return keys;
    const a = allowedKind("add-damage");
    if (!a.ok) return a;
    const spec = damageSpec(v["add-damage"], `${path}.add-damage`);
    if (!spec.ok) return spec;
    return ok({ kind: "add-damage", ...spec.value });
  }

  if ("saving-throw" in v) {
    const keys = unknownKeys(v, ["saving-throw", "on-fail", "on-success"], path);
    if (!keys.ok) return keys;
    const a = allowedKind("saving-throw");
    if (!a.ok) return a;
    const st = v["saving-throw"];
    if (!isObj(st)) return err(`${path}.saving-throw: expected {ability: con, dc: 20}`);
    const stKeys = unknownKeys(st, ["ability", "dc"], `${path}.saving-throw`);
    if (!stKeys.ok) return stKeys;
    const ability = typeof st["ability"] === "string" ? st["ability"].toLowerCase() : "";
    if (!ABILITIES.includes(ability as Ability)) {
      return err(`${path}.saving-throw.ability: expected one of ${ABILITIES.join(", ")}`);
    }
    const dc = formula(st["dc"], `${path}.saving-throw.dc`);
    if (!dc.ok) return dc;
    const onFail = actions(v["on-fail"], `${path}.on-fail`, hook);
    if (!onFail.ok) return onFail;
    const onSuccess = actions(v["on-success"], `${path}.on-success`, hook);
    if (!onSuccess.ok) return onSuccess;
    return ok({ kind: "saving-throw", ability: ability as Ability, dc: dc.value, onFail: onFail.value, onSuccess: onSuccess.value });
  }

  if ("condition" in v) {
    const keys = unknownKeys(v, ["condition", "until", "to"], path);
    if (!keys.ok) return keys;
    const a = allowedKind("condition");
    if (!a.ok) return a;
    const name = typeof v["condition"] === "string" ? v["condition"].toLowerCase() : "";
    if (!CONDITION_NAMES.includes(name as ConditionName)) {
      return err(`${path}.condition: unknown condition "${String(v["condition"])}" (expected one of ${CONDITION_NAMES.join(", ")})`);
    }
    const u = until(v["until"], `${path}.until`);
    if (!u.ok) return u;
    const t = target(v["to"], `${path}.to`, toFallback);
    if (!t.ok) return t;
    const tc = checkTo(t.value);
    if (!tc.ok) return tc;
    return ok({ kind: "condition", condition: name as ConditionName, to: t.value, ...(u.value ? { until: u.value } : {}) });
  }

  if ("temphp" in v) {
    const keys = unknownKeys(v, ["temphp", "to"], path);
    if (!keys.ok) return keys;
    const a = allowedKind("temphp");
    if (!a.ok) return a;
    const amount = formula(v["temphp"], `${path}.temphp`);
    if (!amount.ok) return amount;
    const t = target(v["to"], `${path}.to`, "self");
    if (!t.ok) return t;
    const tc = checkTo(t.value);
    if (!tc.ok) return tc;
    return ok({ kind: "temphp", amount: amount.value, to: t.value });
  }

  if ("set-hp" in v) {
    const keys = unknownKeys(v, ["set-hp"], path);
    if (!keys.ok) return keys;
    const a = allowedKind("set-hp");
    if (!a.ok) return a;
    const amount = formula(v["set-hp"], `${path}.set-hp`);
    if (!amount.ok) return amount;
    return ok({ kind: "set-hp", amount: amount.value });
  }

  if (GRANT_KEYS.some((k) => k in v)) {
    const keys = unknownKeys(v, [...GRANT_KEYS, "until", "to"], path);
    if (!keys.ok) return keys;
    const a = allowedKind("grant");
    if (!a.ok) return a;
    const g = grant(v, path);
    if (!g.ok) return g;
    const u = until(v["until"], `${path}.until`);
    if (!u.ok) return u;
    if (hook === "always" && u.value) return err(`${path}.until: static (on: always) grants are permanent; remove until`);
    if (hook !== "always" && !u.value) return err(`${path}: a triggered grant needs an until`);
    const t = target(v["to"], `${path}.to`, "self");
    if (!t.ok) return t;
    const tc = checkTo(t.value);
    if (!tc.ok) return tc;
    return ok({ kind: "grant", grant: g.value, to: t.value, ...(u.value ? { until: u.value } : {}) });
  }

  return err(`${path}: no recognised action (expected one of: ${[...GRANT_KEYS, "scale", "ignore", "add-damage", "saving-throw", "condition", "temphp", "set-hp"].join(", ")})`);
}

function actions(v: unknown, path: string, hook: Hook): Result<Action[], string> {
  if (v === undefined || v === null) return ok([]);
  const list = Array.isArray(v) ? v : [v];
  const out: Action[] = [];
  for (const [i, item] of list.entries()) {
    const a = action(item, Array.isArray(v) ? `${path}[${i}]` : path, hook);
    if (!a.ok) return a;
    out.push(a.value);
  }
  return ok(out);
}

function uses(v: Obj, path: string): Result<UsesSpec | undefined, string> {
  const which = v["uses"] !== undefined ? "uses" : v["charges"] !== undefined ? "charges" : null;
  if (which === null) return ok(undefined);
  if (v["uses"] !== undefined && v["charges"] !== undefined) return err(`${path}: give uses or charges, not both`);
  const u = v[which];
  const where = `${path}.${which}`;
  if (!isObj(u)) return err(`${where}: expected {max: 1, per: long-rest}`);
  const keys = unknownKeys(u, ["max", "per", "regain"], where);
  if (!keys.ok) return keys;
  const max = formula(u["max"], `${where}.max`);
  if (!max.ok) return max;
  const per = u["per"] ?? "never";
  if (per !== "never" && !REST_PERIODS.includes(per as never)) {
    return err(`${where}.per: expected one of ${[...REST_PERIODS, "never"].join(", ")}`);
  }
  let regain: UsesSpec["regain"];
  if (u["regain"] !== undefined) {
    const r = u["regain"];
    if (typeof r === "string" && /\d*d\d+/i.test(r)) {
      const d = parseDice(r.replace(/\s+/g, ""));
      if (!d.ok) return err(`${where}.regain: ${d.error}`);
      regain = { dice: r.replace(/\s+/g, "") };
    } else {
      const f = formula(r, `${where}.regain`);
      if (!f.ok) return f;
      regain = { formula: f.value };
    }
  }
  return ok({ max: max.value, per: per as UsesSpec["per"], ...(regain ? { regain } : {}) });
}

function feature(v: Obj, path: string): Result<Feature, string> {
  const keys = unknownKeys(v, ["feature", "name", "text", "uses", "charges"], path);
  if (!keys.ok) return keys;
  const name = v["feature"] ?? v["name"];
  if (typeof name !== "string" || name.trim() === "") return err(`${path}: a feature needs a name`);
  const text = v["text"];
  if (typeof text !== "string" || text.trim() === "") return err(`${path}: feature "${name}" needs text`);
  const u = uses(v, path);
  if (!u.ok) return u;
  return ok({ name: name.trim(), text: text.trim(), ...(u.value ? { uses: u.value } : {}) });
}

function effect(v: unknown, path: string, defName: string, index: number): Result<Effect, string> {
  if (!isObj(v)) return err(`${path}: expected an effect map`);
  const keys = unknownKeys(v, ["name", "on", "when", "unless", "do", "may", "uses", "charges"], path);
  if (!keys.ok) return keys;
  const hook = (v["on"] ?? "always") as Hook;
  if (!HOOKS.includes(hook)) return err(`${path}.on: expected one of ${HOOKS.join(", ")}`);
  if (v["may"] !== undefined && typeof v["may"] !== "boolean") return err(`${path}.may: expected true or false`);
  const may = v["may"] === true;
  const u = uses(v, path);
  if (!u.ok) return u;
  const name = v["name"];
  if (name !== undefined && (typeof name !== "string" || name.trim() === "")) return err(`${path}.name: expected text`);
  if ((may || u.value) && name === undefined) {
    return err(`${path}: an effect with may or uses needs a name, so the DM can refer to it`);
  }
  const when = condition(v["when"], `${path}.when`);
  if (!when.ok) return when;
  const unless = condition(v["unless"], `${path}.unless`);
  if (!unless.ok) return unless;
  if (v["do"] === undefined) return err(`${path}: missing "do"`);
  const acts = actions(v["do"], `${path}.do`, hook);
  if (!acts.ok) return acts;
  if (acts.value.length === 0) return err(`${path}.do: needs at least one action`);
  if (hook === "would-drop-to-0" && !acts.value.some((a) => a.kind === "set-hp")) {
    return err(`${path}: on: would-drop-to-0 needs a set-hp action (what the creature drops to instead)`);
  }
  return ok({
    name: typeof name === "string" ? name.trim() : `${defName} #${index + 1}`,
    hook,
    actions: acts.value,
    may,
    ...(when.value ? { when: when.value } : {}),
    ...(unless.value ? { unless: unless.value } : {}),
    ...(u.value ? { uses: u.value } : {}),
  });
}

function attackSpec(v: unknown, path: string, defName: string): Result<AttackSpec, string> {
  if (!isObj(v)) return err(`${path}: expected {bonus: prof + mod(str), damage: ["1d8 + mod(str):slashing"]}`);
  const keys = unknownKeys(v, ["name", "bonus", "damage", "melee", "range", "long-range"], path);
  if (!keys.ok) return keys;
  const bonus = formula(v["bonus"], `${path}.bonus`);
  if (!bonus.ok) return bonus;
  const rawDamage = Array.isArray(v["damage"]) ? v["damage"] : [v["damage"]];
  const damage = [];
  for (const [i, d] of rawDamage.entries()) {
    const spec = damageSpec(d, `${path}.damage[${i}]`);
    if (!spec.ok) return spec;
    damage.push(spec.value);
  }
  const melee = v["melee"] ?? true;
  if (typeof melee !== "boolean") return err(`${path}.melee: expected true or false`);
  const out: { -readonly [K in keyof AttackSpec]: AttackSpec[K] } = {
    name: typeof v["name"] === "string" ? v["name"] : defName,
    bonus: bonus.value,
    damage,
    melee,
  };
  if (v["range"] !== undefined) {
    const r = integer(v["range"], `${path}.range`);
    if (!r.ok) return r;
    out.range = r.value;
  }
  if (v["long-range"] !== undefined) {
    const r = integer(v["long-range"], `${path}.long-range`);
    if (!r.ok) return r;
    out.longRange = r.value;
  }
  return ok(out);
}

const DEF_KEYS = [
  "name", "kind", "attunement", "text", "replaces-attack", "grants-attack",
  "attack-tags", "creature-tags", "effects", "features",
];

export function validateDef(raw: unknown, where = "effects"): Result<HomebrewDef, string> {
  if (!isObj(raw)) return err(`${where}: expected a definition map with at least name and kind`);
  const keys = unknownKeys(raw, DEF_KEYS, where);
  if (!keys.ok) return keys;

  const name = raw["name"];
  if (typeof name !== "string" || name.trim() === "") return err(`${where}.name: required`);
  const kind = raw["kind"] as DefKind;
  if (!DEF_KINDS.includes(kind)) return err(`${where}.kind: expected one of ${DEF_KINDS.join(", ")}`);
  const attunement = raw["attunement"] ?? false;
  if (typeof attunement !== "boolean") return err(`${where}.attunement: expected true or false`);
  const text = raw["text"];
  if (text !== undefined && typeof text !== "string") return err(`${where}.text: expected text`);

  if (raw["replaces-attack"] !== undefined && raw["grants-attack"] !== undefined) {
    return err(`${where}: give replaces-attack or grants-attack, not both`);
  }
  if ((raw["replaces-attack"] !== undefined || raw["grants-attack"] !== undefined) && kind !== "weapon") {
    return err(`${where}: only kind: weapon can replace or grant an attack`);
  }
  const replaces = raw["replaces-attack"];
  if (replaces !== undefined && (typeof replaces !== "string" || replaces.trim() === "")) {
    return err(`${where}.replaces-attack: expected the name of an attack on the sheet`);
  }
  let grants: AttackSpec | undefined;
  if (raw["grants-attack"] !== undefined) {
    const g = attackSpec(raw["grants-attack"], `${where}.grants-attack`, name.trim());
    if (!g.ok) return g;
    grants = g.value;
  }

  const attackTags = stringList(raw["attack-tags"], `${where}.attack-tags`);
  if (!attackTags.ok) return attackTags;
  const creatureTags = stringList(raw["creature-tags"], `${where}.creature-tags`);
  if (!creatureTags.ok) return creatureTags;

  const effects: Effect[] = [];
  const features: Feature[] = [];
  const rawEffects = raw["effects"] ?? [];
  if (!Array.isArray(rawEffects)) return err(`${where}.effects: expected a list`);
  for (const [i, e] of rawEffects.entries()) {
    const path = `${where}.effects[${i}]`;
    if (isObj(e) && "feature" in e) {
      const f = feature(e, path);
      if (!f.ok) return f;
      features.push(f.value);
      continue;
    }
    const parsed = effect(e, path, name.trim(), i);
    if (!parsed.ok) return parsed;
    effects.push(parsed.value);
  }
  const rawFeatures = raw["features"] ?? [];
  if (!Array.isArray(rawFeatures)) return err(`${where}.features: expected a list`);
  for (const [i, f] of rawFeatures.entries()) {
    if (!isObj(f)) return err(`${where}.features[${i}]: expected a map`);
    const parsed = feature(f, `${where}.features[${i}]`);
    if (!parsed.ok) return parsed;
    features.push(parsed.value);
  }

  const names = new Set<string>();
  for (const n of [...effects.map((e) => e.name), ...features.map((f) => f.name)]) {
    if (names.has(n.toLowerCase())) return err(`${where}: two effects or features are both named "${n}"`);
    names.add(n.toLowerCase());
  }

  return ok({
    id: slugify(name),
    name: name.trim(),
    kind,
    attunement,
    attackTags: attackTags.value,
    creatureTags: creatureTags.value,
    effects,
    features,
    ...(text !== undefined ? { text: text.trim() } : {}),
    ...(typeof replaces === "string" ? { replacesAttack: replaces.trim() } : {}),
    ...(grants ? { grantsAttack: grants } : {}),
  });
}
