/**
 * Defensive readers for the D&D Beyond character payload.
 *
 * The character service is undocumented and can change shape without notice,
 * so nothing here trusts the input. Every reader narrows `unknown` and returns
 * a fallback rather than throwing, which keeps the normalizer total.
 */

export type Json = unknown;

export function isObject(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function obj(v: Json, key: string): Record<string, Json> | undefined {
  if (!isObject(v)) return undefined;
  const child = v[key];
  return isObject(child) ? child : undefined;
}

export function arr(v: Json, key: string): Json[] {
  if (!isObject(v)) return [];
  const child = v[key];
  return Array.isArray(child) ? child : [];
}

export function num(v: Json, key: string): number | undefined {
  if (!isObject(v)) return undefined;
  const child = v[key];
  return typeof child === "number" && Number.isFinite(child) ? child : undefined;
}

export function str(v: Json, key: string): string | undefined {
  if (!isObject(v)) return undefined;
  const child = v[key];
  return typeof child === "string" ? child : undefined;
}

export function bool(v: Json, key: string): boolean | undefined {
  if (!isObject(v)) return undefined;
  const child = v[key];
  return typeof child === "boolean" ? child : undefined;
}

/** DDB nests the sheet under `data` when served by the character service. */
export function unwrapEnvelope(raw: Json): Json {
  const data = obj(raw, "data");
  return data ?? raw;
}
