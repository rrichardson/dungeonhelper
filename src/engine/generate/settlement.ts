/** Settlement generation: somewhere to arrive, with something already wrong. */

import type { Rng } from "../rng.ts";
import { pick, pickSome, pickWeighted, buildName } from "./pick.ts";
import { generateMerchant, shopKinds, type Merchant } from "./merchant.ts";
import {
  NAME_PARTS, SETTLEMENT_SIZES, GOVERNMENTS, INDUSTRIES, PROBLEMS,
  LANDMARKS, RUMOURS,
} from "./tables.ts";

export interface Settlement {
  readonly name: string;
  readonly size: string;
  readonly population: number;
  readonly government: string;
  readonly industry: string;
  readonly problem: string;
  readonly landmarks: readonly string[];
  readonly rumours: readonly string[];
  readonly shops: readonly Merchant[];
}

export interface SettlementOptions {
  readonly size?: string;
  readonly shops?: number;
}

export function settlementSizes(): string[] {
  return SETTLEMENT_SIZES.map((s) => s.name);
}

export function generateSettlement(rng: Rng, options: SettlementOptions = {}): Settlement {
  const size = options.size
    ? (SETTLEMENT_SIZES.find((s) => s.name === options.size) ?? SETTLEMENT_SIZES[1]!)
    : pickWeighted(SETTLEMENT_SIZES.map((s) => ({ value: s, weight: s.weight })), rng);

  // A settlement should not field two alchemists and no general store, so the
  // trades are drawn without replacement. A general store comes first when
  // there is more than one shop: somewhere has to sell rope.
  const shopCount = Math.max(0, options.shops ?? size.shops);
  const available = shopKinds();
  const preferred = shopCount > 1 && available.includes("general store") ? ["general store"] : [];
  const rest = pickSome(
    available.filter((k) => !preferred.includes(k)),
    Math.max(0, shopCount - preferred.length),
    rng,
  );

  const shops: Merchant[] = [];
  for (const kind of [...preferred, ...rest]) {
    const made = generateMerchant(rng, { kind });
    if (made.ok) shops.push(made.value);
  }

  return {
    name: buildName(NAME_PARTS.settlement, rng),
    size: size.name,
    population: rng.int(size.min, size.max),
    government: pick(GOVERNMENTS, rng),
    industry: pick(INDUSTRIES, rng),
    problem: pick(PROBLEMS, rng),
    landmarks: pickSome(LANDMARKS, rng.int(1, 3), rng),
    rumours: pickSome(RUMOURS, rng.int(2, 4), rng),
    shops,
  };
}
