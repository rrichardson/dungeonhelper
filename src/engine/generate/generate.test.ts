import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRng } from "../rng.ts";
import { pick, pickWeighted, pickSome, chance } from "./pick.ts";
import { generateMerchant, shopKinds, formatCoins } from "./merchant.ts";
import { generateSettlement, settlementSizes } from "./settlement.ts";
import { generateWilderness, terrainNames, travelCost, MAX_DIMENSION } from "./wilderness.ts";

test("weighted picks never choose a zero-weight entry", () => {
  const rng = makeRng("weights");
  for (let i = 0; i < 500; i++) {
    const chosen = pickWeighted([{ value: "yes", weight: 1 }, { value: "no", weight: 0 }], rng);
    assert.equal(chosen, "yes");
  }
});

test("pickSome returns distinct entries and never more than exist", () => {
  const rng = makeRng("some");
  const source = ["a", "b", "c"];
  const three = pickSome(source, 3, rng);
  assert.equal(new Set(three).size, 3);
  assert.equal(pickSome(source, 99, rng).length, 3);
  assert.equal(pickSome(source, 0, rng).length, 0);
});

test("chance respects its bounds", () => {
  const rng = makeRng("chance");
  for (let i = 0; i < 200; i++) {
    assert.equal(chance(0, rng), false);
    assert.equal(chance(100, rng), true);
  }
});

test("coins render as gold, silver and copper", () => {
  assert.equal(formatCoins(0), "0 cp");
  assert.equal(formatCoins(1), "1 cp");
  assert.equal(formatCoins(10), "1 sp");
  assert.equal(formatCoins(100), "1 gp");
  assert.equal(formatCoins(157), "1 gp 5 sp 7 cp");
  assert.equal(formatCoins(5000), "50 gp");
});

// ── Merchants ─────────────────────────────────────────────────────────────

test("a merchant stocks only goods its trade would carry", () => {
  const r = generateMerchant(makeRng("smith"), { kind: "smithy" });
  assert.ok(r.ok);
  assert.equal(r.value.shopKind, "smithy");
  assert.ok(r.value.stock.length > 0);
  for (const item of r.value.stock) {
    assert.ok(item.priceCp > 0, `${item.name} must cost something`);
    assert.ok(item.quantity >= 1);
  }
});

test("markup is applied consistently to every line", () => {
  const r = generateMerchant(makeRng("markup"), { kind: "general store" });
  assert.ok(r.ok);
  const { markupPercent } = r.value;
  for (const item of r.value.stock) {
    assert.equal(item.priceCp, Math.round(item.basePriceCp * (1 + markupPercent / 100)));
  }
});

test("an unknown shop kind is refused with the list of valid kinds", () => {
  const r = generateMerchant(makeRng("x"), { kind: "wandmonger" });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /known kinds are/);
});

test("stock lines never exceed the trade's catalogue", () => {
  const r = generateMerchant(makeRng("deep"), { kind: "fletcher", stockLines: 99 });
  assert.ok(r.ok);
  assert.equal(new Set(r.value.stock.map((s) => s.name)).size, r.value.stock.length);
});

test("the same seed generates the same merchant", () => {
  const a = generateMerchant(makeRng("same"), { kind: "smithy" });
  const b = generateMerchant(makeRng("same"), { kind: "smithy" });
  assert.deepEqual(a, b);
});

test("every advertised shop kind generates", () => {
  for (const kind of shopKinds()) {
    const r = generateMerchant(makeRng(`k-${kind}`), { kind });
    assert.ok(r.ok, `${kind} failed to generate`);
  }
});

// ── Settlements ───────────────────────────────────────────────────────────

test("population falls inside the band for its size", () => {
  const bands: Record<string, [number, number]> = {
    hamlet: [20, 80], village: [80, 400], town: [400, 4000], city: [4000, 25000],
  };
  for (const size of settlementSizes()) {
    const s = generateSettlement(makeRng(`pop-${size}`), { size });
    const [min, max] = bands[size]!;
    assert.ok(s.population >= min && s.population <= max, `${size} population ${s.population}`);
  }
});

test("a settlement's trades are distinct", () => {
  for (let i = 0; i < 20; i++) {
    const s = generateSettlement(makeRng(`trades-${i}`), { size: "city" });
    const kinds = s.shops.map((shop) => shop.shopKind);
    assert.equal(new Set(kinds).size, kinds.length, `duplicate trade in ${kinds.join(", ")}`);
  }
});

test("a settlement with several shops has somewhere to buy rope", () => {
  const s = generateSettlement(makeRng("rope"), { size: "town" });
  assert.ok(s.shops.some((shop) => shop.shopKind === "general store"));
});

test("shop count can be forced, including to none", () => {
  assert.equal(generateSettlement(makeRng("none"), { shops: 0 }).shops.length, 0);
  assert.equal(generateSettlement(makeRng("three"), { shops: 3 }).shops.length, 3);
});

test("a settlement always has a problem and at least one rumour", () => {
  for (let i = 0; i < 25; i++) {
    const s = generateSettlement(makeRng(`s-${i}`));
    assert.ok(s.problem.length > 0);
    assert.ok(s.rumours.length >= 1);
    assert.ok(s.landmarks.length >= 1);
  }
});

// ── Wilderness ────────────────────────────────────────────────────────────

test("a map has exactly the requested dimensions", () => {
  const r = generateWilderness(makeRng("dim"), { width: 7, height: 4 });
  assert.ok(r.ok);
  assert.equal(r.value.tiles.length, 4);
  for (const row of r.value.tiles) assert.equal(row.length, 7);
});

test("tile coordinates match their position in the grid", () => {
  const r = generateWilderness(makeRng("coords"), { width: 5, height: 3 });
  assert.ok(r.ok);
  r.value.tiles.forEach((row, y) => {
    row.forEach((tile, x) => {
      assert.equal(tile.x, x);
      assert.equal(tile.y, y);
    });
  });
});

test("every tile has a known terrain and a positive travel cost", () => {
  const r = generateWilderness(makeRng("terrain"), { width: 12, height: 8 });
  assert.ok(r.ok);
  const known = new Set(terrainNames());
  for (const tile of r.value.tiles.flat()) {
    assert.ok(known.has(tile.terrain));
    assert.ok(travelCost(tile) >= 1);
  }
});

test("a dominant terrain actually dominates", () => {
  const r = generateWilderness(makeRng("marshy"), { width: 14, height: 10, dominant: "marsh" });
  assert.ok(r.ok);
  const tiles = r.value.tiles.flat();
  const marsh = tiles.filter((t) => t.terrain === "marsh").length;
  assert.ok(marsh / tiles.length > 0.3, `marsh was only ${marsh}/${tiles.length}`);
});

test("terrain forms regions rather than noise", () => {
  const r = generateWilderness(makeRng("regions"), { width: 16, height: 12 });
  assert.ok(r.ok);
  let matching = 0;
  let compared = 0;
  for (const row of r.value.tiles) {
    for (let x = 1; x < row.length; x++) {
      compared++;
      if (row[x]!.terrain === row[x - 1]!.terrain) matching++;
    }
  }
  // Six terrains picked at random would match about 1 time in 6.
  assert.ok(matching / compared > 0.35, `neighbour match rate was ${matching}/${compared}`);
});

test("oversized and empty maps are refused", () => {
  assert.equal(generateWilderness(makeRng("x"), { width: 0, height: 5 }).ok, false);
  assert.equal(generateWilderness(makeRng("x"), { width: MAX_DIMENSION + 1, height: 5 }).ok, false);
});

test("an unknown dominant terrain is refused", () => {
  const r = generateWilderness(makeRng("x"), { dominant: "lava" as never });
  assert.equal(r.ok, false);
});

test("features are not repeated while fresh ones remain", () => {
  const r = generateWilderness(makeRng("features"), { width: 6, height: 5, featureChance: 100 });
  assert.ok(r.ok);
  const byTerrain = new Map<string, string[]>();
  for (const tile of r.value.tiles.flat()) {
    if (tile.feature === null) continue;
    const list = byTerrain.get(tile.terrain) ?? [];
    list.push(tile.feature);
    byTerrain.set(tile.terrain, list);
  }
  for (const [terrain, features] of byTerrain) {
    const distinct = new Set(features).size;
    assert.ok(distinct >= Math.min(features.length, 3), `${terrain} reused features too early`);
  }
});

test("the same seed generates the same map", () => {
  const a = generateWilderness(makeRng("mapseed"), { width: 8, height: 6 });
  const b = generateWilderness(makeRng("mapseed"), { width: 8, height: 6 });
  assert.deepEqual(a, b);
});
