/** Rendering generated content for the console. Presentation only. */

import { formatCoins, type Merchant } from "../engine/generate/merchant.ts";
import type { Settlement } from "../engine/generate/settlement.ts";
import { TERRAIN_GLYPHS, travelCost, type WildernessMap } from "../engine/generate/wilderness.ts";
import { TERRAIN_COST } from "../engine/generate/tables.ts";

export function formatMerchant(m: Merchant, seed: string): string {
  const lines: string[] = [];
  lines.push(`${m.shopName}  —  ${m.shopKind}`);
  lines.push(
    `  ${m.proprietor.name}, ${m.proprietor.species} · ${m.attitude}` +
      ` · haggle DC ${m.haggleDc} · ${m.markupPercent >= 0 ? "+" : ""}${m.markupPercent}% prices`,
  );
  lines.push(`  ${m.proprietor.demeanour}`);
  lines.push(`  quirk: ${m.proprietor.quirk}`);
  lines.push("");

  const width = Math.max(...m.stock.map((s) => s.name.length));
  for (const item of m.stock) {
    const price = formatCoins(item.priceCp).padStart(12);
    const base = item.priceCp === item.basePriceCp ? "" : `  (list ${formatCoins(item.basePriceCp)})`;
    lines.push(`  ${item.name.padEnd(width)}  x${String(item.quantity).padStart(2)}  ${price}${base}`);
  }

  lines.push("");
  lines.push(`  DM only — the proprietor ${m.secret}`);
  lines.push(`  (seed ${seed})`);
  return lines.join("\n");
}

export function formatSettlement(s: Settlement, seed: string): string {
  const lines: string[] = [];
  lines.push(`${s.name}  —  ${s.size}, population ${s.population.toLocaleString("en-US")}`);
  lines.push(`  ruled by ${s.government}`);
  lines.push(`  lives on ${s.industry}`);
  lines.push("");
  lines.push(`  Right now: ${s.problem}`);

  if (s.landmarks.length > 0) {
    lines.push("");
    lines.push("  Landmarks");
    for (const l of s.landmarks) lines.push(`    - ${l}`);
  }

  if (s.rumours.length > 0) {
    lines.push("");
    lines.push("  Overheard");
    for (const r of s.rumours) lines.push(`    - ${r}`);
  }

  if (s.shops.length > 0) {
    lines.push("");
    lines.push("  Trade");
    for (const shop of s.shops) {
      lines.push(`    ${shop.shopName} (${shop.shopKind}) — ${shop.proprietor.name}, ${shop.attitude}`);
    }
    lines.push("    (run `dnd gen merchant --kind <kind>` for full stock)");
  }

  lines.push("");
  lines.push(`  (seed ${seed})`);
  return lines.join("\n");
}

export function formatWilderness(map: WildernessMap, seed: string): string {
  const lines: string[] = [];
  lines.push(`Wilderness — ${map.width}x${map.height}, ${map.scaleMiles} miles per tile`);
  lines.push("");

  // Column ruler, then the grid itself.
  const header = Array.from({ length: map.width }, (_, x) => String(x % 10)).join(" ");
  lines.push(`     ${header}`);
  for (const row of map.tiles) {
    const glyphs = row.map((t) => TERRAIN_GLYPHS[t.terrain]).join(" ");
    lines.push(`  ${String(row[0]!.y).padStart(2)} ${glyphs}`);
  }

  lines.push("");
  const legend = Object.entries(TERRAIN_GLYPHS)
    .map(([name, glyph]) => `${glyph} ${name} (x${TERRAIN_COST[name as keyof typeof TERRAIN_COST]})`)
    .join("   ");
  lines.push(`  ${legend}`);
  lines.push("  travel cost is a multiple of open ground");

  const notable = map.tiles.flat().filter((t) => t.feature !== null);
  if (notable.length > 0) {
    lines.push("");
    lines.push("  Features");
    for (const tile of notable) {
      lines.push(
        `    (${tile.x},${tile.y}) ${tile.terrain} x${travelCost(tile)} — ${tile.feature}` +
          (tile.event ? `; ${tile.event}` : ""),
      );
    }
  }

  lines.push("");
  lines.push(`  (seed ${seed})`);
  return lines.join("\n");
}
