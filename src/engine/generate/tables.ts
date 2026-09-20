/**
 * Content tables for generation.
 *
 * Written for this project rather than copied from any published product.
 * Equipment names and prices follow the SRD, which is CC-BY licensed.
 */

export const NAME_PARTS = {
  person: {
    starts: ["bal", "cor", "dre", "ely", "fen", "gar", "hal", "ira", "jor", "kel", "lum", "mer", "nor", "ory", "per", "quen", "riv", "sel", "tor", "ul", "ver", "wyn", "yar", "zel"],
    middles: ["a", "an", "el", "im", "or", "ul", "en", "ar", "is", "ov"],
    ends: ["a", "ak", "en", "eth", "ia", "ik", "is", "on", "or", "ra", "ric", "us", "wyn", "yn"],
  },
  settlement: {
    starts: ["ash", "black", "bright", "cold", "deep", "elm", "fair", "green", "grim", "hollow", "iron", "long", "north", "oak", "red", "salt", "stone", "thorn", "west", "white"],
    middles: ["", "", "water", "wood", "moor", "fen"],
    ends: ["barrow", "bridge", "brook", "burn", "combe", "crest", "dale", "ford", "gate", "haven", "hollow", "march", "mill", "reach", "stead", "watch", "well", "wick"],
  },
} as const;

export const SPECIES = [
  "human", "hill dwarf", "mountain dwarf", "high elf", "wood elf", "halfling",
  "gnome", "half-orc", "tiefling", "dragonborn", "half-elf",
] as const;

export const DEMEANOURS = [
  "brisk and businesslike", "warm but distractible", "suspicious of strangers",
  "desperate for conversation", "bored to the point of rudeness", "relentlessly cheerful",
  "quietly grieving", "nervous, keeps glancing at the door", "haughty about their craft",
  "drunk, and hiding it badly", "deaf in one ear and too proud to say so",
  "convinced the party are someone else",
] as const;

export const QUIRKS = [
  "counts coins twice, always",
  "names every item in the shop",
  "will not sell to anyone wearing red",
  "throws in something free if you compliment the cat",
  "keeps a ledger of every customer's face",
  "speaks about the goods in the third person",
  "insists on telling the history of each item",
  "has a parrot that repeats the prices, wrongly",
  "refuses to haggle, but will trade favours",
  "gives discounts to anyone who can beat them at dice",
  "wears gloves indoors and never explains",
  "closes the shutters whenever someone mentions the north road",
] as const;

export const SHOP_SECRETS = [
  "is fencing goods for a local gang",
  "is being extorted by the watch",
  "has a cellar that connects to the old tunnels",
  "is hiding a relative wanted for murder",
  "buys from a supplier who is not what they claim",
  "has not paid the guild dues in two years",
  "keeps one cursed item locked in the back",
  "is quietly dying and looking for a successor",
  "reports every stranger to someone in the capital",
  "owes a debt that comes due this month",
] as const;

export interface StockItem {
  readonly name: string;
  /** Base price in copper pieces, to keep the arithmetic exact. */
  readonly cp: number;
}

export const SHOP_KINDS: Readonly<Record<string, readonly StockItem[]>> = {
  "general store": [
    { name: "backpack", cp: 200 }, { name: "bedroll", cp: 100 }, { name: "rope, hempen (50 ft)", cp: 100 },
    { name: "torch", cp: 1 }, { name: "rations (1 day)", cp: 50 }, { name: "tinderbox", cp: 50 },
    { name: "waterskin", cp: 20 }, { name: "lantern, hooded", cp: 500 }, { name: "oil (flask)", cp: 10 },
    { name: "crowbar", cp: 200 }, { name: "hammer", cp: 100 }, { name: "piton", cp: 5 },
    { name: "grappling hook", cp: 200 }, { name: "chalk", cp: 1 }, { name: "sack", cp: 1 },
  ],
  smithy: [
    { name: "dagger", cp: 200 }, { name: "shortsword", cp: 1000 }, { name: "longsword", cp: 1500 },
    { name: "handaxe", cp: 500 }, { name: "battleaxe", cp: 1000 }, { name: "warhammer", cp: 1500 },
    { name: "spear", cp: 100 }, { name: "shield", cp: 1000 }, { name: "chain shirt", cp: 5000 },
    { name: "scale mail", cp: 5000 }, { name: "breastplate", cp: 40000 }, { name: "helm (plain)", cp: 300 },
  ],
  apothecary: [
    { name: "healer's kit", cp: 500 }, { name: "herbalism kit", cp: 500 },
    { name: "antitoxin", cp: 5000 }, { name: "potion of healing", cp: 5000 },
    { name: "bandages, bundle", cp: 20 }, { name: "poultice for burns", cp: 80 },
    { name: "sleeping draught", cp: 300 }, { name: "willow bark, dram", cp: 30 },
  ],
  fletcher: [
    { name: "shortbow", cp: 2500 }, { name: "longbow", cp: 5000 }, { name: "crossbow, light", cp: 2500 },
    { name: "arrows (20)", cp: 100 }, { name: "crossbow bolts (20)", cp: 100 },
    { name: "quiver", cp: 100 }, { name: "bowstring, spare", cp: 20 },
  ],
  tailor: [
    { name: "common clothes", cp: 50 }, { name: "fine clothes", cp: 1500 },
    { name: "traveler's clothes", cp: 200 }, { name: "cloak, oiled", cp: 400 },
    { name: "boots, sturdy", cp: 300 }, { name: "costume", cp: 500 },
  ],
  alchemist: [
    { name: "acid (vial)", cp: 2500 }, { name: "alchemist's fire (flask)", cp: 5000 },
    { name: "alchemist's supplies", cp: 5000 }, { name: "basic poison (vial)", cp: 10000 },
    { name: "perfume (vial)", cp: 500 }, { name: "soap", cp: 2 },
  ],
  jeweller: [
    { name: "silver ring", cp: 500 }, { name: "gold locket", cp: 2500 },
    { name: "gemstone, small", cp: 5000 }, { name: "signet ring", cp: 500 },
    { name: "silvered chain", cp: 500 }, { name: "jeweler's tools", cp: 2500 },
  ],
  stable: [
    { name: "riding horse", cp: 7500 }, { name: "draft horse", cp: 5000 },
    { name: "pony", cp: 3000 }, { name: "mule", cp: 800 }, { name: "saddle, riding", cp: 1000 },
    { name: "feed (1 day)", cp: 5 }, { name: "cart", cp: 1500 },
  ],
};

export const SETTLEMENT_SIZES = [
  { name: "hamlet", min: 20, max: 80, shops: 1, weight: 30 },
  { name: "village", min: 80, max: 400, shops: 2, weight: 35 },
  { name: "town", min: 400, max: 4000, shops: 4, weight: 25 },
  { name: "city", min: 4000, max: 25000, shops: 7, weight: 10 },
] as const;

export const GOVERNMENTS = [
  "a hereditary lord who is rarely seen",
  "an elected council of guild masters",
  "a temple hierarchy that also keeps the peace",
  "a magistrate appointed from the capital",
  "an uneasy alliance of three families",
  "whoever currently holds the granary",
  "a garrison commander acting well beyond her orders",
  "no one, openly; a smuggler settles disputes",
] as const;

export const INDUSTRIES = [
  "river trade", "sheep and wool", "tin mining", "salt panning", "timber",
  "fishing", "vineyards", "quarry stone", "horse breeding", "charcoal burning",
  "pilgrim traffic", "border tolls",
] as const;

export const PROBLEMS = [
  "the wells have turned brackish and nobody knows why",
  "a toll collector has begun taking more than the toll",
  "children have been sleepwalking toward the treeline",
  "the harvest was good, and the tithe collector has not come",
  "two families are one insult away from open violence",
  "something has been taking livestock, but leaving the meat",
  "the bridge is failing and the mason has vanished",
  "a stranger has been buying up debts",
  "the garrison has not been paid in three months",
  "an old grave was opened from the inside, or so they say",
  "the miller is selling short weight and everyone knows",
  "a sickness that only affects those who drink the beer",
] as const;

export const LANDMARKS = [
  "a standing stone worn smooth by hands",
  "a well far deeper than the village needs",
  "the burnt shell of a manor house",
  "a bridge with three arches and one sealed",
  "an oak with iron nails driven into the trunk",
  "a shrine nobody admits to maintaining",
  "a watchtower with no stair to the top",
  "a millpond that never freezes",
  "a boundary ditch older than the settlement",
  "a gibbet, empty, kept in good repair",
] as const;

export const RUMOURS = [
  "the old road is quicker, but nobody uses it after dark",
  "the lord's steward has been seen counting graves",
  "there is a door in the quarry that was not cut by miners",
  "a peddler paid for lodging in coins two centuries out of date",
  "the river ran red for an hour last spring",
  "someone has been leaving food at the treeline, and it is being taken",
  "the previous magistrate left in the night and took the records",
  "there are lights in the marsh that move against the wind",
  "the smith will not shoe horses for travelers going north",
  "a child came back from the woods speaking a language nobody knows",
] as const;

export type Terrain =
  | "plains" | "forest" | "hills" | "mountains" | "marsh" | "water";

export const TERRAIN_GLYPHS: Readonly<Record<Terrain, string>> = {
  plains: ".", forest: "♣", hills: "^", mountains: "▲", marsh: "~", water: "≈",
};

/** Travel cost per tile, as a multiple of open ground. */
export const TERRAIN_COST: Readonly<Record<Terrain, number>> = {
  plains: 1, forest: 2, hills: 2, mountains: 4, marsh: 3, water: 4,
};

export const TERRAIN_FEATURES: Readonly<Record<Terrain, readonly string[]>> = {
  plains: ["a cairn of field stones", "an abandoned steading", "a crossroads shrine", "a fallow field gone to thistle", "a drover's camp, recently used"],
  forest: ["a clearing with a cold firepit", "a deadfall blocking the path", "a charcoal burner's hut", "trees blazed with an unfamiliar mark", "a spring under a split rock"],
  hills: ["a barrow with the turf disturbed", "a shepherd's bothy", "an old quarry, flooded", "a beacon platform, unlit", "a defile where the wind never stops"],
  mountains: ["a pass choked with scree", "a bridge of rope over a gorge", "a mine adit, timbered and dark", "an eyrie on a crag", "a shrine cut into the rockface"],
  marsh: ["a causeway of laid logs, half sunk", "a wicker fish trap, still set", "an island of firm ground", "bones in the reeds, not all animal", "a boat staked in the mud"],
  water: ["a ford marked by withies", "a wreck on the shoal", "a ferry with no ferryman", "an eyot with a single tree", "nets drying on a frame"],
};

export const WILDERNESS_EVENTS = [
  "tracks crossing the path, heading the other way",
  "smoke on the horizon, thin and steady",
  "a traveler going the opposite direction, in a hurry",
  "carrion birds circling something out of sight",
  "weather turning hard within the hour",
  "a sound that stops when you stop",
  "a boundary marker for a domain nobody mentioned",
  "fresh diggings, backfilled badly",
] as const;
