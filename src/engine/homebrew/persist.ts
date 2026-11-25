/**
 * Reading the homebrew parts of a stored creature back from JSON.
 *
 * Attached definitions are re-validated from their authoring source on every
 * load, so a hand-edited encounter or stat block cannot smuggle in a
 * definition the validator would refuse. Pools and timers are engine-written
 * state; they get shape checks with exact messages.
 */

import { type Result, ok, err } from "../result.ts";
import { CONDITION_NAMES, type ConditionName } from "../types.ts";
import { validateDef } from "./schema.ts";
import { REST_PERIODS, type Attached, type Expiry, type Grant, type ResourcePool, type Timed } from "./types.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export interface HomebrewFields {
  readonly tags?: readonly string[];
  readonly classLevels?: Readonly<Record<string, number>>;
  readonly level?: number;
  readonly homebrew?: readonly Attached[];
  readonly resources?: Readonly<Record<string, ResourcePool>>;
  readonly timed?: readonly Timed[];
}

function classLevelsOf(o: Obj, where: string): Result<Record<string, number> | undefined, string> {
  const direct = o["classLevels"];
  if (direct !== undefined) {
    if (!isObj(direct)) return err(`${where}: "classLevels" must be an object like {"fighter": 20}`);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(direct)) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return err(`${where}: classLevels.${k} must be a whole number`);
      out[k.toLowerCase()] = v;
    }
    return ok(out);
  }
  // D&D Beyond imports record classes under meta.
  const meta = o["meta"];
  if (isObj(meta) && Array.isArray(meta["classes"])) {
    const out: Record<string, number> = {};
    for (const c of meta["classes"]) {
      if (isObj(c) && typeof c["name"] === "string" && typeof c["level"] === "number") {
        const key = c["name"].toLowerCase();
        out[key] = (out[key] ?? 0) + c["level"];
      }
    }
    return ok(Object.keys(out).length > 0 ? out : undefined);
  }
  return ok(undefined);
}

function levelOf(o: Obj, where: string): Result<number | undefined, string> {
  const direct = o["level"];
  if (direct !== undefined) {
    if (typeof direct !== "number" || !Number.isInteger(direct) || direct < 0) return err(`${where}: "level" must be a whole number`);
    return ok(direct);
  }
  const meta = o["meta"];
  if (isObj(meta) && typeof meta["totalLevel"] === "number") return ok(meta["totalLevel"]);
  return ok(undefined);
}

function attachedOf(o: Obj, where: string): Result<Attached[] | undefined, string> {
  const raw = o["homebrew"];
  if (raw === undefined) return ok(undefined);
  if (!Array.isArray(raw)) return err(`${where}: "homebrew" must be an array`);
  const out: Attached[] = [];
  for (const [i, item] of raw.entries()) {
    const at = `${where}: homebrew[${i}]`;
    if (!isObj(item)) return err(`${at}: expected an object`);
    const def = validateDef(item["source"], `${at}.source`);
    if (!def.ok) return def;
    const origin = item["origin"];
    if (origin !== "loadout" && origin !== "trait" && origin !== "attached") {
      return err(`${at}.origin: expected loadout, trait or attached`);
    }
    out.push({
      def: def.value,
      source: item["source"],
      attuned: item["attuned"] === true,
      origin,
      ...(typeof item["note"] === "string" ? { note: item["note"] } : {}),
      ...(typeof item["asAttack"] === "string" ? { asAttack: item["asAttack"] } : {}),
      ...(typeof item["replaced"] === "string" ? { replaced: item["replaced"] } : {}),
    });
  }
  return ok(out);
}

function resourcesOf(o: Obj, where: string): Result<Record<string, ResourcePool> | undefined, string> {
  const raw = o["resources"];
  if (raw === undefined) return ok(undefined);
  if (!isObj(raw)) return err(`${where}: "resources" must be an object`);
  const out: Record<string, ResourcePool> = {};
  for (const [key, p] of Object.entries(raw)) {
    const at = `${where}: resources.${key}`;
    if (!isObj(p)) return err(`${at}: expected an object`);
    const { label, max, used, per, regain } = p;
    if (typeof label !== "string") return err(`${at}.label: expected text`);
    if (typeof max !== "number" || typeof used !== "number" || used < 0) return err(`${at}: max and used must be numbers`);
    if (per !== "never" && !REST_PERIODS.includes(per as never)) return err(`${at}.per: unknown period "${String(per)}"`);
    let parsedRegain: ResourcePool["regain"];
    if (isObj(regain) && typeof regain["dice"] === "string") parsedRegain = { dice: regain["dice"] };
    else if (isObj(regain) && typeof regain["amount"] === "number") parsedRegain = { amount: regain["amount"] };
    out[key] = { label, max, used: Math.min(used, max), per: per as ResourcePool["per"], ...(parsedRegain ? { regain: parsedRegain } : {}) };
  }
  return ok(out);
}

function timedOf(o: Obj, where: string): Result<Timed[] | undefined, string> {
  const raw = o["timed"];
  if (raw === undefined) return ok(undefined);
  if (!Array.isArray(raw)) return err(`${where}: "timed" must be an array`);
  const out: Timed[] = [];
  for (const [i, t] of raw.entries()) {
    const at = `${where}: timed[${i}]`;
    if (!isObj(t) || typeof t["label"] !== "string") return err(`${at}: expected {label, expires}`);
    const e = t["expires"];
    let expires: Expiry;
    if (isObj(e) && e["kind"] === "end-of-turn" && typeof e["of"] === "string" && typeof e["skip"] === "number") {
      expires = { kind: "end-of-turn", of: e["of"], skip: e["skip"] };
    } else if (isObj(e) && e["kind"] === "rounds" && typeof e["of"] === "string" && typeof e["remaining"] === "number") {
      expires = { kind: "rounds", of: e["of"], remaining: e["remaining"] };
    } else {
      return err(`${at}.expires: expected {kind: "end-of-turn", of, skip} or {kind: "rounds", of, remaining}`);
    }
    const condition = t["condition"];
    if (condition !== undefined && !CONDITION_NAMES.includes(condition as ConditionName)) {
      return err(`${at}.condition: unknown condition "${String(condition)}"`);
    }
    const grant = t["grant"];
    if (grant !== undefined && !isObj(grant)) return err(`${at}.grant: expected an object`);
    out.push({
      label: t["label"],
      expires,
      ...(condition !== undefined ? { condition: condition as ConditionName } : {}),
      ...(grant !== undefined ? { grant: grant as Grant } : {}),
    });
  }
  return ok(out);
}

export function parseHomebrewFields(o: Obj, where: string): Result<HomebrewFields, string> {
  const rawTags = o["tags"];
  let tags: string[] | undefined;
  if (rawTags !== undefined) {
    if (!Array.isArray(rawTags) || rawTags.some((t) => typeof t !== "string")) return err(`${where}: "tags" must be a list of text`);
    tags = (rawTags as string[]).map((t) => t.toLowerCase());
  }
  const classLevels = classLevelsOf(o, where);
  if (!classLevels.ok) return classLevels;
  const level = levelOf(o, where);
  if (!level.ok) return level;
  const homebrew = attachedOf(o, where);
  if (!homebrew.ok) return homebrew;
  const resources = resourcesOf(o, where);
  if (!resources.ok) return resources;
  const timed = timedOf(o, where);
  if (!timed.ok) return timed;
  return ok({
    ...(tags !== undefined ? { tags } : {}),
    ...(classLevels.value !== undefined ? { classLevels: classLevels.value } : {}),
    ...(level.value !== undefined ? { level: level.value } : {}),
    ...(homebrew.value !== undefined ? { homebrew: homebrew.value } : {}),
    ...(resources.value !== undefined ? { resources: resources.value } : {}),
    ...(timed.value !== undefined ? { timed: timed.value } : {}),
  });
}
