/**
 * Merchant and shop generation.
 *
 * Prices are held in copper pieces so the arithmetic stays exact; markup is
 * applied once and rounded to the nearest copper.
 */

import type { Rng } from "../rng.ts";
import { type Result, ok, err } from "../result.ts";
import { pick, pickSome, pickWeighted, chance, buildName } from "./pick.ts";
import {
  NAME_PARTS, SPECIES, DEMEANOURS, QUIRKS, SHOP_SECRETS, SHOP_KINDS,
} from "./tables.ts";

export type Attitude = "hostile" | "unfriendly" | "indifferent" | "friendly" | "helpful";

export interface StockLine {
  readonly name: string;
  readonly quantity: number;
  /** Price per unit after markup, in copper. */
  readonly priceCp: number;
  readonly basePriceCp: number;
}

export interface Merchant {
  readonly shopKind: string;
  readonly shopName: string;
  readonly proprietor: {
    readonly name: string;
    readonly species: string;
    readonly demeanour: string;
    readonly quirk: string;
  };
  readonly secret: string;
  readonly attitude: Attitude;
  /** Percent added to (or removed from) base price. */
  readonly markupPercent: number;
  /** DC to talk the price down, derived from attitude. */
  readonly haggleDc: number;
  readonly stock: readonly StockLine[];
}

const ATTITUDES: { value: Attitude; weight: number; markup: number; dc: number }[] = [
  { value: "hostile", weight: 5, markup: 40, dc: 20 },
  { value: "unfriendly", weight: 20, markup: 20, dc: 17 },
  { value: "indifferent", weight: 45, markup: 10, dc: 15 },
  { value: "friendly", weight: 22, markup: 0, dc: 12 },
  { value: "helpful", weight: 8, markup: -10, dc: 10 },
];

const SHOP_NAME_PATTERNS = [
  (owner: string, kind: string) => `${owner}'s ${kind}`,
  (owner: string) => `The ${owner} House`,
  (_owner: string, kind: string) => `The Honest ${kind}`,
  (owner: string) => `${owner} & Daughters`,
  (owner: string) => `${owner} & Sons`,
];

/** Render copper as the usual gp / sp / cp breakdown. */
export function formatCoins(cp: number): string {
  const total = Math.max(0, Math.round(cp));
  const gp = Math.floor(total / 100);
  const sp = Math.floor((total % 100) / 10);
  const rem = total % 10;
  const parts: string[] = [];
  if (gp > 0) parts.push(`${gp} gp`);
  if (sp > 0) parts.push(`${sp} sp`);
  if (rem > 0 || parts.length === 0) parts.push(`${rem} cp`);
  return parts.join(" ");
}

export interface MerchantOptions {
  /** A specific kind of shop; otherwise one is chosen. */
  readonly kind?: string;
  /** How many distinct lines to stock. */
  readonly stockLines?: number;
}

export function shopKinds(): string[] {
  return Object.keys(SHOP_KINDS).sort();
}

export function generateMerchant(rng: Rng, options: MerchantOptions = {}): Result<Merchant, string> {
  const kinds = shopKinds();
  const kind = options.kind ?? pick(kinds, rng);
  const catalogue = SHOP_KINDS[kind];
  if (!catalogue) {
    return err(`unknown shop kind "${kind}"; known kinds are ${kinds.join(", ")}`);
  }

  const attitude = pickWeighted(ATTITUDES.map((a) => ({ value: a, weight: a.weight })), rng);
  const ownerName = buildName(NAME_PARTS.person, rng);
  const pattern = pick(SHOP_NAME_PATTERNS, rng);

  const lines = Math.max(1, Math.min(catalogue.length, options.stockLines ?? rng.int(4, 8)));
  const chosen = pickSome(catalogue, lines, rng);

  const stock: StockLine[] = chosen.map((item) => {
    // Cheap goods are stocked deeply; expensive goods one or two at a time.
    const quantity = item.cp <= 100 ? rng.int(3, 20) : item.cp <= 2000 ? rng.int(1, 4) : 1;
    const priceCp = Math.round(item.cp * (1 + attitude.markup / 100));
    return { name: item.name, quantity, priceCp, basePriceCp: item.cp };
  });

  return ok({
    shopKind: kind,
    shopName: pattern(ownerName, kind),
    proprietor: {
      name: ownerName,
      species: pick(SPECIES, rng),
      demeanour: pick(DEMEANOURS, rng),
      quirk: pick(QUIRKS, rng),
    },
    secret: pick(SHOP_SECRETS, rng),
    attitude: attitude.value,
    markupPercent: attitude.markup,
    haggleDc: attitude.dc,
    stock,
  });
}

/** A one-line summary, for listing shops inside a settlement. */
export function merchantSummary(m: Merchant): string {
  return `${m.shopName} (${m.shopKind}) — ${m.proprietor.name}, ${m.proprietor.species}, ${m.attitude}`;
}

export { chance };
