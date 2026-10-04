/**
 * Port of api/parsing/mana_symbols.py — which symbols may appear in a mana cost.
 *
 * The companion to spans.ts, and deliberately separate: spans answers where a `{...}` ends, this
 * answers whether what is inside it means anything. The second question cannot be decided per
 * character — every character of `{A/B/C/D}` is individually legal — so it takes the symbol whole.
 *
 * Narrower than "every real Magic symbol" on purpose. `{T}`, `{Q}`, `{E}`, `{CHAOS}` and `{PW}`
 * are all real, but none can appear in a mana cost, and a mana cost is the only thing a MANA-class
 * field (`mana`/`m`, `devotion`) matches against. Searching for one is a query that can never
 * match, so it is worth a 400 rather than an empty result set.
 */

/** `{([^}]*)}` — shared with the Python card_query_nodes.BRACED_MANA_SYMBOL. */
const BRACED_MANA_SYMBOL = /\{([^}]*)\}/gu;

const DIGITS: ReadonlySet<string> = new Set("0123456789");

/**
 * The bare characters a mana value may carry outside braces — the alphabet mana_cost_str_to_dict
 * and calculate_cmc count (upstream #958 made bare `S` agree with `{S}`).
 */
export const BARE_MANA_ATOMS: ReadonlySet<string> = new Set("WUBRGCXS");

// Derived from BARE_MANA_ATOMS exactly as upstream derives it — `_BARE_ATOMS - frozenset("CX")` —
// so the two can't silently disagree. That makes `S` a "colour" here, as it is upstream at
// ccb562a8 (`{2/S}` and `{S/P}` validate); this mirrors the pinned behaviour, not a judgement.
const COLORS: ReadonlySet<string> = new Set([...BARE_MANA_ATOMS].filter((c) => c !== "C" && c !== "X"));

/**
 * LOCAL PATCH (Cloudflare port): the one-part symbols only the un-sets print, and the ones Scryfall
 * reads though no cost prints them.
 *
 * Upstream leaves these out on purpose — it drops every `set_type == "funny"` card at import, so
 * no cost its queries can match holds them — and this port imports those cards. Measured on
 * api.scryfall.com 2026-10-04: `mana:{hw}` is 1 (Little Girl, whose whole cost is {HW}) and so are
 * `mana={hw}` and `mana>={hw}`; `{y}` and `{z}` are The Ultimate Nightmare of Wizards of the
 * Coast® Customer Service's ({X}{Y}{Z}{R}{R}); and `mana:{h}`, `mana:{hr}`, `mana:{l}`,
 * `mana:{l}{l}` and `mana:{c/p}` are each a plain 404 with no warning — honored, and matching
 * nothing. Each was `Failed to parse query` here. (`{hu}` is NOT one: Scryfall names “{H}” unknown
 * there, which the compat surface says before this is asked.)
 *
 * The engine needs nothing for them: a symbol that is not one of its lanes is compared by name
 * against the store's own mana vocabulary (engine/builder/tests/odd_mana_symbols.rs).
 */
const UN_SET_ATOMS: readonly string[] = ["Y", "Z", "L", "H", "HW", "HR"];

// Single-character atoms: a colour, colourless, snow, and X. Phyrexian ('P') is deliberately
// absent: it never appears unpaired in a real cost, only through the paired shapes below.
const ATOMS: ReadonlySet<string> = new Set([...COLORS, "C", "S", "X", ...UN_SET_ATOMS]);

// The generic side of generic-hybrid mana is always specifically '2' ({2/W}, never {1/W}).
const GENERIC_HYBRID_VALUE = "2";

// Colourless joins colour on the "which side does this go on" ambiguity a hybrid pair has, so both
// share one permutation-generated set of ordered pairs. Generic and phyrexian don't: every printing
// has the generic side first and the phyrexian side last, so those two are one-directional.
const HYBRID_ATOMS: ReadonlySet<string> = new Set([...COLORS, "C"]);

function permutations2(items: ReadonlySet<string>): string[][] {
	const out: string[][] = [];
	for (const a of items) for (const b of items) if (a !== b) out.push([a, b]);
	return out;
}

// Every valid 2- or 3-part shape, as the exact "/"-joined string `symbol.split("/")` must produce.
// Permutations never repeat an element in one draw, so {W/W}, {2/2} and {C/C} are excluded for free.
const PART_SHAPES: ReadonlySet<string> = new Set([
	...permutations2(HYBRID_ATOMS).map((p) => p.join("/")), // hybrid & colourless hybrid, either order
	...[...COLORS].map((c) => `${GENERIC_HYBRID_VALUE}/${c}`), // generic hybrid, generic first: {2/W}
	...[...COLORS].map((c) => `${c}/P`), // phyrexian, colour first: {W/P}
	...permutations2(COLORS).map(([a, b]) => `${a}/${b}/P`), // hybrid-phyrexian, colours either order
	"C/P", // LOCAL PATCH: colourless phyrexian, honored on Scryfall though no cost prints it — see UN_SET_ATOMS
]);

/** Whether `part` is a whole one-part symbol: generic mana of any size, or a single atom. */
function isAtom(part: string): boolean {
	if (part.length > 0 && [...part].every((c) => DIGITS.has(c))) return true;
	return ATOMS.has(part);
}

/** Whether `symbol` — the text between the braces, upper-cased — can appear in a mana cost. */
export function isValidManaSymbol(symbol: string): boolean {
	if (symbol.length === 0) return false;
	const parts = symbol.split("/");
	if (parts.length === 1) return isAtom(parts[0] as string);
	return PART_SHAPES.has(symbol);
}

/**
 * The first symbol in `value` that no mana cost could contain, or null if every one can.
 *
 * Braced symbols are checked as a whole; bare characters between (and after) them one at a time
 * against BARE_MANA_ATOMS, in a single left-to-right walk. Without this, a bare character neither
 * counting function recognises — 'Q' in '2WWQ', or all of 'hello' — is silently dropped instead of
 * rejected: `mana:2WWQ` would quietly run as `mana:2WW`.
 */
export function firstInvalidManaSymbol(value: string): string | null {
	let pos = 0;
	for (const match of value.matchAll(BRACED_MANA_SYMBOL)) {
		for (const c of value.slice(pos, match.index)) {
			if (!DIGITS.has(c) && !BARE_MANA_ATOMS.has(c)) return c;
		}
		const symbol = match[1] as string;
		if (!isValidManaSymbol(symbol)) return `{${symbol}}`;
		pos = match.index + match[0].length;
	}
	for (const c of value.slice(pos)) {
		if (!DIGITS.has(c) && !BARE_MANA_ATOMS.has(c)) return c;
	}
	return null;
}
