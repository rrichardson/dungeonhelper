/**
 * Open5e API client — the I/O edge of SRD lookup.
 *
 * Defaults to the 2024 SRD (5.2). No auth. Nothing here interprets a stat
 * block: normalization lives in engine/import/open5e.ts.
 */

import { type Result, ok, err } from "../engine/result.ts";
import type { FetchLike } from "./ddb.ts";

export const OPEN5E_BASE = "https://api.open5e.com";

/** Open5e document keys for the two rulesets. */
export const DOCUMENT_2024 = "srd-2024";
export const DOCUMENT_2014 = "wotc-srd";

export interface Open5eDeps {
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
  /** Override the SRD document; empty string searches every source. */
  readonly document?: string;
}

async function getJson(url: string, deps: Open5eDeps): Promise<Result<unknown, string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30_000);
  try {
    const res = await deps.fetch(url, { signal: controller.signal });
    const body = await res.text();
    if (!res.ok) return err(`Open5e returned HTTP ${res.status} for ${url}`);
    try {
      return ok(JSON.parse(body));
    } catch {
      return err(`Open5e returned a response that is not JSON (${body.slice(0, 120)}…)`);
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.toLowerCase().includes("abort")) return err(`Open5e request timed out: ${url}`);
    return err(`could not reach Open5e: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

function resultsOf(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload === null) return [];
  const results = (payload as { results?: unknown }).results;
  return Array.isArray(results) ? results : [];
}

function query(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

export interface SearchOptions {
  readonly limit?: number;
  /** Pass "" to search across every source rather than one SRD. */
  readonly document?: string;
}

function documentOf(deps: Open5eDeps, options: SearchOptions | undefined): string | undefined {
  const chosen = options?.document ?? deps.document ?? DOCUMENT_2024;
  return chosen === "" ? undefined : chosen;
}

/** Creatures whose name contains `name`. */
export async function searchCreatures(
  name: string,
  deps: Open5eDeps,
  options: SearchOptions = {},
): Promise<Result<unknown[], string>> {
  const url = `${OPEN5E_BASE}/v2/creatures/?${query({
    name__icontains: name,
    document__key: documentOf(deps, options),
    limit: options.limit ?? 10,
  })}`;
  const payload = await getJson(url, deps);
  if (!payload.ok) return payload;
  return ok(resultsOf(payload.value));
}

/** The single best match for a creature name, preferring an exact hit. */
export async function findCreature(
  name: string,
  deps: Open5eDeps,
  options: SearchOptions = {},
): Promise<Result<unknown, string>> {
  const exactUrl = `${OPEN5E_BASE}/v2/creatures/?${query({
    name__iexact: name,
    document__key: documentOf(deps, options),
  })}`;
  const exact = await getJson(exactUrl, deps);
  if (!exact.ok) return exact;
  const exactHits = resultsOf(exact.value);
  if (exactHits.length > 0) return ok(exactHits[0]);

  const matches = await searchCreatures(name, deps, options);
  if (!matches.ok) return matches;
  if (matches.value.length === 0) return err(`no creature matching "${name}" in the SRD`);
  if (matches.value.length > 1) {
    const names = matches.value
      .map((c) => (c as { name?: string }).name ?? "?")
      .slice(0, 8)
      .join(", ");
    return err(`"${name}" matches several creatures: ${names} — name one exactly`);
  }
  return ok(matches.value[0]);
}

export async function searchSpells(
  name: string,
  deps: Open5eDeps,
  options: SearchOptions = {},
): Promise<Result<unknown[], string>> {
  const url = `${OPEN5E_BASE}/v2/spells/?${query({
    name__icontains: name,
    document__key: documentOf(deps, options),
    limit: options.limit ?? 10,
  })}`;
  const payload = await getJson(url, deps);
  if (!payload.ok) return payload;
  return ok(resultsOf(payload.value));
}

/**
 * Conditions are filtered here rather than by the API: the endpoint silently
 * ignores `name__icontains` and returns the whole list, which would otherwise
 * look like a match for any query. The list is small, so fetching it all and
 * filtering locally is both cheaper and more honest than trusting the filter.
 */
export async function searchConditions(
  name: string,
  deps: Open5eDeps,
  options: SearchOptions = {},
): Promise<Result<unknown[], string>> {
  const url = `${OPEN5E_BASE}/v2/conditions/?${query({ limit: 100 })}`;
  const payload = await getJson(url, deps);
  if (!payload.ok) return payload;

  const wanted = name.trim().toLowerCase();
  const matches = resultsOf(payload.value).filter((c) => {
    const found = (c as { name?: unknown }).name;
    return typeof found === "string" && found.toLowerCase().includes(wanted);
  });
  return ok(matches.slice(0, options.limit ?? 20));
}
