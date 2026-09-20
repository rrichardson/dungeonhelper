/**
 * D&D Beyond fetch adapter — the I/O edge of the importer.
 *
 * The character service is unofficial but is what every third-party importer
 * uses. It needs no auth; it does need the character's privacy set to Public.
 * Nothing here interprets the payload: parsing lives in engine/import/ddb.ts.
 */

import { type Result, ok, err } from "../engine/result.ts";

export const DDB_CHARACTER_SERVICE = "https://character-service.dndbeyond.com/character/v5/character";

/** Injected so callers can supply a stub in tests. */
export interface FetchLike {
  (url: string, init?: { signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

/**
 * Accepts a bare id, a sheet URL, or a readonly share URL.
 * Pure and total — no network.
 */
export function parseCharacterId(input: string): Result<number, string> {
  const trimmed = input.trim();
  if (trimmed === "") return err("no character id or URL given");

  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n > 0 ? ok(n) : err(`"${input}" is not a valid character id`);
  }

  const m = /dndbeyond\.com\/(?:profile\/[^/]+\/)?characters\/(\d+)/i.exec(trimmed);
  if (m) return ok(Number(m[1]));

  return err(
    `could not find a character id in "${input}" — pass the id, or a URL like https://www.dndbeyond.com/characters/167935384`,
  );
}

export interface FetchDeps {
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
}

/** Fetch the raw character payload. Returns the decoded JSON, uninterpreted. */
export async function fetchDdbCharacter(
  id: number,
  deps: FetchDeps,
): Promise<Result<unknown, string>> {
  const url = `${DDB_CHARACTER_SERVICE}/${id}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30_000);

  try {
    const res = await deps.fetch(url, { signal: controller.signal });
    const body = await res.text();

    if (!res.ok) {
      if (res.status === 403 || res.status === 404) {
        return err(
          `D&D Beyond returned ${res.status} for character ${id}. The sheet must have its privacy set to Public for the character service to serve it.`,
        );
      }
      return err(`D&D Beyond returned HTTP ${res.status} for character ${id}`);
    }

    try {
      return ok(JSON.parse(body));
    } catch {
      return err(`D&D Beyond returned a response that is not JSON (${body.slice(0, 120)}…)`);
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("abort")) return err(`request to D&D Beyond timed out for character ${id}`);
    return err(`could not reach D&D Beyond: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}
