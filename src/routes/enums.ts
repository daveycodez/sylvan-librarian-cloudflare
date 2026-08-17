// Port of api/enums.py. Python StrEnum with enum.auto() lowercases the member
// name, so values here are the lowercased member names in declaration order —
// order matters because ParamCoercionError lists "expected one of: ..." in
// enum declaration order.

export interface EnumSpec<T extends string = string> {
	/** Python class name, used by error messages when no allowed list applies. */
	name: string;
	values: readonly T[];
}

export const UNIQUE_ON = {
	name: "UniqueOn",
	values: ["card", "printing", "artwork"],
} as const satisfies EnumSpec;

export const PREFER_ORDER = {
	name: "PreferOrder",
	values: ["default", "oldest", "newest", "usd_low", "usd_high", "promo"],
} as const satisfies EnumSpec;

// Declaration order, not alphabetical-by-accident: ParamCoercionError renders "expected one of:"
// from this list, and upstream's StrEnum iterates in declaration order. `cubecobra` is this
// project's own; the rest are Scryfall's `order=` vocabulary. Scryfall's `penny` and `review` are
// deliberately absent — see SCRYFALL_ONLY_ORDERS in
// scryfall-compat/routes.ts. `penny_rank` IS stored (on the printing's packed `compat` residue) and
// the card object emits it; what is missing is a sort permutation over it, and only permuted columns
// can order a page.
export const CARD_ORDERING = {
	name: "CardOrdering",
	values: [
		"artist",
		"cmc",
		"color",
		"cubecobra",
		"edhrec",
		"eur",
		"name",
		"power",
		"rarity",
		"released",
		"set",
		"tix",
		"toughness",
		"usd",
	],
} as const satisfies EnumSpec;

export const RESPONSE_SHAPE = {
	name: "ResponseShape",
	values: ["rows", "columnar"],
} as const satisfies EnumSpec;

export const SORT_DIRECTION = {
	name: "SortDirection",
	// `auto` last, matching upstream's declaration order. It is resolved to asc or desc per ordering
	// before the engine sees it, so no search path ever receives it — see resolveDirection.
	values: ["asc", "desc", "auto"],
} as const satisfies EnumSpec;

export type UniqueOn = (typeof UNIQUE_ON.values)[number];
export type PreferOrder = (typeof PREFER_ORDER.values)[number];
export type CardOrdering = (typeof CARD_ORDERING.values)[number];
export type ResponseShape = (typeof RESPONSE_SHAPE.values)[number];
export type SortDirection = (typeof SORT_DIRECTION.values)[number];

/**
 * What `dir=auto` means for each ordering.
 *
 * Measured against api.scryfall.com on 2026-08-09 by comparing the `auto` page against the `asc`
 * and `desc` pages of the same query. Only these five invert; every other ordering, edhrec
 * included, resolves ascending — for edhrec that is the direction putting rank 1 first, so "most
 * popular first" and "ascending rank" are the same thing.
 */
export const AUTO_DESCENDING_ORDERINGS: ReadonlySet<CardOrdering> = new Set<CardOrdering>([
	"released",
	"rarity",
	"usd",
	"tix",
	"eur",
]);

/**
 * Resolve `auto` against an ordering, leaving an explicit direction alone.
 *
 * Must run before the engine options are built: the engine has no AUTO arm, so a direction that
 * reaches it unresolved would fall through to the default and sort the query wrongly rather than
 * failing. Call it after anything that can still change `orderby`.
 */
export function resolveDirection(direction: SortDirection, orderby: CardOrdering): SortDirection {
	if (direction !== "auto") {
		return direction;
	}
	return AUTO_DESCENDING_ORDERINGS.has(orderby) ? "desc" : "asc";
}

// ─── In-query directives (upstream #893) ─────────────────────────────────────
//
// DERIVED from the enums above, not enumerated. Upstream builds these the same
// way — `{str(member): member for member in CardOrdering}` — and that is what
// keeps this independent of #913: an ordering added to CARD_ORDERING is
// accepted as a directive without a second edit here. Hardcoding the spellings
// would turn a free dependency into a real one.
export const DIRECTIVE_ORDER: ReadonlyMap<string, CardOrdering> = new Map(
	CARD_ORDERING.values.map((v) => [v, v] as const),
);

export const DIRECTIVE_DIRECTION: ReadonlyMap<string, SortDirection> = new Map(
	SORT_DIRECTION.values.map((v) => [v, v] as const),
);

// Derived, PLUS the two hyphenated spellings Scryfall accepts. Those are
// enumerated upstream too: the enum members carry underscores (`usd_low`), so
// no derivation produces `usd-low`.
export const DIRECTIVE_PREFER: ReadonlyMap<string, PreferOrder> = new Map<string, PreferOrder>([
	...PREFER_ORDER.values.map((v) => [v, v] as const),
	["usd-low", "usd_low"],
	["usd-high", "usd_high"],
]);

// ENUMERATED, mirroring upstream literally, because this port's enum values are
// not Scryfall's spellings: UNIQUE_ON is card/printing/artwork where Scryfall
// writes cards/prints/art. A derivation would accept only half of these.
export const DIRECTIVE_UNIQUE: ReadonlyMap<string, UniqueOn> = new Map<string, UniqueOn>([
	["card", "card"],
	["cards", "card"],
	["printing", "printing"],
	["printings", "printing"],
	["prints", "printing"],
	["art", "artwork"],
	["artwork", "artwork"],
]);

/** Directive name → the search parameter it sets, its value table, and how to name it in a warning. */
export const DIRECTIVE_TABLES: ReadonlyMap<
	string,
	{ param: string; table: ReadonlyMap<string, string>; label: string }
> = new Map([
	["unique", { param: "unique", table: DIRECTIVE_UNIQUE as ReadonlyMap<string, string>, label: "unique mode" }],
	["sort", { param: "orderby", table: DIRECTIVE_ORDER as ReadonlyMap<string, string>, label: "order choice" }],
	["order", { param: "orderby", table: DIRECTIVE_ORDER as ReadonlyMap<string, string>, label: "order choice" }],
	["direction", { param: "direction", table: DIRECTIVE_DIRECTION as ReadonlyMap<string, string>, label: "direction" }],
	["dir", { param: "direction", table: DIRECTIVE_DIRECTION as ReadonlyMap<string, string>, label: "direction" }],
	["prefer", { param: "prefer", table: DIRECTIVE_PREFER as ReadonlyMap<string, string>, label: "prefer choice" }],
]);
