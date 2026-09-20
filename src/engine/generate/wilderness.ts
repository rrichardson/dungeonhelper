/**
 * Wilderness grid generation.
 *
 * Terrain is grown with a bias toward neighbours already placed, so the map
 * forms regions rather than noise. Generation is left-to-right, top-to-bottom,
 * which makes it fully reproducible from the seed.
 */

import type { Rng } from "../rng.ts";
import { type Result, ok, err } from "./../result.ts";
import { pick, pickWeighted, chance } from "./pick.ts";
import {
  TERRAIN_COST, TERRAIN_FEATURES, TERRAIN_GLYPHS, WILDERNESS_EVENTS,
  type Terrain,
} from "./tables.ts";

export interface Tile {
  readonly x: number;
  readonly y: number;
  readonly terrain: Terrain;
  readonly feature: string | null;
  readonly event: string | null;
}

export interface WildernessMap {
  readonly width: number;
  readonly height: number;
  readonly scaleMiles: number;
  readonly tiles: readonly (readonly Tile[])[];
}

const TERRAINS: Terrain[] = ["plains", "forest", "hills", "mountains", "marsh", "water"];

/** Base frequency before neighbour influence. */
const BASE_WEIGHT: Readonly<Record<Terrain, number>> = {
  plains: 30, forest: 25, hills: 20, mountains: 10, marsh: 8, water: 7,
};

export const MAX_DIMENSION = 40;

export interface WildernessOptions {
  readonly width?: number;
  readonly height?: number;
  /** Terrain to favour across the map. */
  readonly dominant?: Terrain;
  /** Miles across one tile. */
  readonly scaleMiles?: number;
  /** Percent chance a tile carries a notable feature. */
  readonly featureChance?: number;
}

export function terrainNames(): Terrain[] {
  return [...TERRAINS];
}

export function generateWilderness(
  rng: Rng,
  options: WildernessOptions = {},
): Result<WildernessMap, string> {
  const width = Math.trunc(options.width ?? 8);
  const height = Math.trunc(options.height ?? 6);

  if (width < 1 || height < 1) return err("width and height must be at least 1");
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    return err(`maps are limited to ${MAX_DIMENSION}x${MAX_DIMENSION}`);
  }
  if (options.dominant !== undefined && !TERRAINS.includes(options.dominant)) {
    return err(`unknown terrain "${options.dominant}"; expected one of ${TERRAINS.join(", ")}`);
  }

  const featureChance = Math.max(0, Math.min(100, options.featureChance ?? 25));
  const grid: Tile[][] = [];

  // Prefer features not yet placed, so a map does not read as two identical
  // deadfalls in adjacent hexes. Once a terrain's list is exhausted it repeats.
  const usedFeatures = new Set<string>();
  const freshFeature = (terrain: Terrain): string => {
    const all = TERRAIN_FEATURES[terrain];
    const unused = all.filter((f) => !usedFeatures.has(f));
    const chosen = pick(unused.length > 0 ? unused : all, rng);
    usedFeatures.add(chosen);
    return chosen;
  };

  for (let y = 0; y < height; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < width; x++) {
      // Neighbours already placed: the tile to the left and the one above.
      const neighbours: Terrain[] = [];
      if (x > 0) neighbours.push(row[x - 1]!.terrain);
      if (y > 0) neighbours.push(grid[y - 1]![x]!.terrain);

      const weights = TERRAINS.map((terrain) => {
        let weight = BASE_WEIGHT[terrain];
        for (const n of neighbours) if (n === terrain) weight += 45;
        if (options.dominant === terrain) weight += 60;
        return { value: terrain, weight };
      });

      const terrain = pickWeighted(weights, rng);
      const feature = chance(featureChance, rng) ? freshFeature(terrain) : null;
      const event = feature !== null && chance(30, rng) ? pick(WILDERNESS_EVENTS, rng) : null;

      row.push({ x, y, terrain, feature, event });
    }
    grid.push(row);
  }

  return ok({
    width,
    height,
    scaleMiles: Math.max(1, Math.trunc(options.scaleMiles ?? 6)),
    tiles: grid,
  });
}

/** Travel cost of a tile, as a multiple of open ground. */
export function travelCost(tile: Tile): number {
  return TERRAIN_COST[tile.terrain];
}

export { TERRAIN_GLYPHS };
