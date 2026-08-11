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
// deliberately absent — penny_rank lives only inside raw_card_blob, which this port does not store.
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
