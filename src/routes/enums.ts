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

export const CARD_ORDERING = {
	name: "CardOrdering",
	values: ["cmc", "cubecobra", "edhrec", "name", "power", "rarity", "toughness", "usd"],
} as const satisfies EnumSpec;

export const RESPONSE_SHAPE = {
	name: "ResponseShape",
	values: ["rows", "columnar"],
} as const satisfies EnumSpec;

export const SORT_DIRECTION = {
	name: "SortDirection",
	values: ["asc", "desc"],
} as const satisfies EnumSpec;

export type UniqueOn = (typeof UNIQUE_ON.values)[number];
export type PreferOrder = (typeof PREFER_ORDER.values)[number];
export type CardOrdering = (typeof CARD_ORDERING.values)[number];
export type ResponseShape = (typeof RESPONSE_SHAPE.values)[number];
export type SortDirection = (typeof SORT_DIRECTION.values)[number];
