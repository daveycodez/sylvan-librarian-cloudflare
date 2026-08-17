// Mana cost parsing for `GET /symbology/parse-mana`. Port of api/scryfall_compat/mana.py
// (upstream #922).
//
// The one route on the reference surface that is computed rather than mirrored: it takes a cost
// written any way a human might write it (`RUW`, `2WW`, `{X}{R}{R}`) and returns Scryfall's
// normalized form plus the colors, mana value and the three colour-count flags. Being a pure
// function of its parameter, it is also the only one that answers correctly before any import.
//
// Two behaviours upstream measured against api.scryfall.com rather than inferred, both carried over
// with the reasoning because nothing documents them:
//
//   - The normalized cost REORDERS colored pips into canonical colour order, so `RUW` comes back as
//     `{U}{R}{W}` (Jeskai) rather than as written. `canonicalColors` is that rule.
//   - Emission order is X, then generic, then colored pips, then `{C}`, regardless of input order,
//     with generic summed into one symbol: `2XWU` is `{X}{2}{W}{U}`, and `1{1}` is `{2}`.

/** The colour wheel. Every canonical ordering is a walk around this cycle. */
const WUBRG = ["W", "U", "B", "R", "G"] as const;
const COLOR_INDEX: Record<string, number> = Object.fromEntries(WUBRG.map((color, index) => [color, index]));

/** Mana that is not a colour: colorless and snow. */
const COLORLESS_PIPS = new Set(["C", "S"]);

/** Variable pips, which contribute nothing to mana value. */
const VARIABLE_PIPS = new Set(["X", "Y", "Z"]);

/** Half-mana symbols are written {HW}; the half applies to the symbol after the H. */
const HALF_MANA = 0.5;

/** A fragment of the cost could not be understood as mana. */
export class ManaCostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManaCostError";
	}
}

/**
 * Order a colour set the way Magic writes it.
 *
 * Every canonical ordering — allied pairs, enemy pairs, shards, wedges, four-colour runs and WUBRG
 * itself — is a walk around the colour wheel taking a constant number of steps: one for anything
 * contiguous (`{G}{W}` for Selesnya, `{W}{U}{B}` for Esper), two for the arrangements that are not
 * (`{R}{W}` for Boros, `{U}{R}{W}` for Jeskai). Trying step 1 before step 2, from starting points in
 * WUBRG order, picks the same arrangement Scryfall does for all 31 colour combinations.
 */
function canonicalColors(colors: Set<string>): string[] {
	if (colors.size === 0) return [];
	const wanted = new Set([...colors].map((color) => COLOR_INDEX[color] as number));
	for (const step of [1, 2]) {
		for (let start = 0; start < WUBRG.length; start++) {
			const walk: number[] = [];
			for (let offset = 0; offset < wanted.size; offset++) walk.push((start + offset * step) % WUBRG.length);
			if (
				walk.length === wanted.size &&
				walk.every((index) => wanted.has(index)) &&
				new Set(walk).size === walk.length
			) {
				return walk.map((index) => WUBRG[index] as string);
			}
		}
	}
	// Unreachable for any subset of WUBRG, but a colour set that is not one must still come back
	// deterministically rather than as nothing.
	return WUBRG.filter((color) => colors.has(color));
}

/** The colours one braced symbol contributes; empty for generic, variable and colorless pips. */
function symbolColors(symbol: string): Set<string> {
	const body = symbol.startsWith("H") ? symbol.slice(1) : symbol;
	return new Set(body.split("/").filter((part) => part in COLOR_INDEX));
}

/**
 * The mana value one braced symbol contributes.
 *
 * @throws ManaCostError if the symbol is not mana at all.
 */
function symbolValue(symbol: string): number {
	if (/^\d+$/.test(symbol)) return Number.parseInt(symbol, 10);
	if (VARIABLE_PIPS.has(symbol)) return 0;
	if (symbol.startsWith("H") && symbol.length > 1) return HALF_MANA;
	if (symbol.includes("/")) {
		// A hybrid has exactly TWO halves. `{W/U/B}` is not a Magic symbol and Scryfall rejects it
		// (422, measured 2026-08-16); this port summed it to 1 and answered a three-coloured
		// `mana_cost` for a cost that cannot be printed. Each half must also be a colour, a generic
		// amount, or Phyrexian `P` — the same three things the value rule below knows how to price.
		const halves = symbol.split("/");
		const priceable = (part: string): boolean => /^\d+$/.test(part) || part in COLOR_INDEX || part === "P";
		if (halves.length !== 2 || !halves.every(priceable)) throw new UnparseableSymbol();
		// A hybrid is worth its more expensive half: {2/W} is 2, {W/U} and {W/P} are 1.
		return Math.max(...halves.map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : 1)));
	}
	if (COLORLESS_PIPS.has(symbol) || symbol in COLOR_INDEX) return 1;
	throw new UnparseableSymbol();
}

/**
 * Internal signal that ONE token is not mana — never thrown out of this module.
 *
 * The message Scryfall sends names EVERY unparseable fragment of the cost at once ("The string
 * fragment(s) …"), so the fragments have to be collected before any error can be worded. Throwing
 * the finished `ManaCostError` from here reported only the first, and reported it re-braced: `!!!`
 * came back as `“{!}”` where Scryfall says `“!!!”`.
 */
class UnparseableSymbol extends Error {}

const BRACED = /^\{([^}]*)\}/;
const DIGITS = /^\d+/;

/**
 * Split a written cost into braced-symbol contents.
 *
 * Unbraced runs are read a character at a time, except digits, which group so `11R` is `{11}{R}`
 * rather than `{1}{1}{R}`.
 */
interface Token {
	/** The symbol's contents, brace-stripped and uppercased — what every rule below reads. */
	symbol: string;
	/** How it was WRITTEN, uppercased: braced tokens keep their braces, bare characters do not. */
	spelling: string;
	/** True for a braced token, which is what stops `!!` and `{!}{!}` from merging into one fragment. */
	braced: boolean;
}

function tokenize(raw: string): Token[] {
	const tokens: Token[] = [];
	const upper = raw.toUpperCase();
	let position = 0;
	while (position < upper.length) {
		const rest = upper.slice(position);
		const braced = BRACED.exec(rest);
		if (braced) {
			tokens.push({ symbol: (braced[1] as string).trim(), spelling: braced[0], braced: true });
			position += braced[0].length;
			continue;
		}
		const digits = DIGITS.exec(rest);
		if (digits) {
			tokens.push({ symbol: digits[0], spelling: digits[0], braced: false });
			position += digits[0].length;
			continue;
		}
		const char = upper[position] as string;
		if (!/\s/.test(char)) tokens.push({ symbol: char, spelling: char, braced: false });
		position += 1;
	}
	return tokens;
}

/**
 * How Scryfall names the parts of a cost it could not read — measured, one request per row
 * (2026-08-16):
 *
 *   ?cost=!!!         “!!!”      three bare characters, reported as ONE run
 *   ?cost=é           “É”        uppercased, and reported as itself rather than re-braced
 *   ?cost={QQQ}       “{QQQ}”    a braced token keeps its braces
 *   ?cost={}          “{}”       including the empty one
 *   ?cost={W/U/B}     “{//}”     the RECOGNIZED halves are struck out and the residue reported
 *
 * The last row is the rule the others are a degenerate case of: what comes back is the fragment with
 * everything Scryfall could read removed. `{QQQ}` keeps all three Qs because none of them is a
 * symbol; `{W/U/B}` keeps only its punctuation.
 */
function reportedFragment(token: Token): string {
	if (!token.braced) return token.spelling;
	const residue = [...token.symbol]
		.filter((ch) => !(ch in COLOR_INDEX) && !COLORLESS_PIPS.has(ch) && !VARIABLE_PIPS.has(ch) && !/[\dPH]/.test(ch))
		.join("");
	return `{${residue}}`;
}

/**
 * Assemble the normalized cost string. A cost whose symbols all cancel to nothing renders as `{0}`.
 */
function renderCost(
	variables: string[],
	generic: number,
	colored: string[],
	colorless: string[],
	colors: string[],
): string {
	const rank = new Map(colors.map((color, index) => [color, index]));
	const sortKey = (symbol: string, at: number): [number, number] => {
		// A multi-colour symbol sorts by its earliest colour, which keeps hybrids next to the pips
		// they share a colour with rather than at one end.
		const own = [...symbolColors(symbol)].map((color) => rank.get(color) ?? rank.size);
		return [own.length > 0 ? Math.min(...own) : rank.size, at];
	};
	const ordered = colored
		.map((symbol, at) => ({ symbol, key: sortKey(symbol, at) }))
		.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])
		.map((entry) => entry.symbol);

	// Variables come out in X, Y, Z order regardless of how they were written, and repeats group:
	// `?cost=xyzzy` is `{X}{Y}{Y}{Z}{Z}` on api.scryfall.com (measured 2026-08-16) where writing
	// order would have given `{X}{Y}{Z}{Z}{Y}`. A plain sort does both at once — the alphabet and
	// the pip order coincide.
	const parts = [...variables].sort().map((symbol) => `{${symbol}}`);
	if (generic) parts.push(`{${generic}}`);
	parts.push(...ordered.map((symbol) => `{${symbol}}`));
	parts.push(...colorless.map((symbol) => `{${symbol}}`));
	return parts.join("") || "{0}";
}

/**
 * How many CHARACTERS of the joined fragment list the error names before Scryfall cuts it.
 *
 * 51, and it is characters rather than bytes — measured across nine lengths on 2026-08-16: 51 `a`s
 * come back whole and 52 come back as 51, while 51 `é`s (102 bytes) also come back whole and 60 come
 * back as 51 characters / 102 bytes. The cut is applied to the WHOLE joined list, not per fragment:
 * ten separate `{QQQQQQQQ}` tokens come back as 51 characters of the concatenation.
 *
 * No ellipsis, unlike `/cards/collection`'s 30-character echo — the string simply stops. 51 is an odd
 * bound and nothing here explains it, which is why it is a named constant carrying its measurement
 * rather than an inline number.
 */
const FRAGMENT_ECHO_LIMIT = 51;

/** Cut the joined fragment list where Scryfall cuts it, counting code points rather than UTF-16 units. */
function truncateFragments(fragments: string): string {
	const points = [...fragments];
	return points.length > FRAGMENT_ECHO_LIMIT ? points.slice(0, FRAGMENT_ECHO_LIMIT).join("") : fragments;
}

/**
 * Scryfall's ManaCost object for a written cost.
 *
 * @throws ManaCostError if a fragment is not mana.
 */
export function parseManaCost(raw: string): Record<string, unknown> {
	const tokens = tokenize(raw ?? "");

	let generic = 0;
	const variables: string[] = [];
	const colored: string[] = [];
	const colorless: string[] = [];
	const colorSet = new Set<string>();
	let total = 0;

	// EVERY unparseable fragment is collected before any error is raised, because Scryfall's message
	// names them all at once — CONCATENATED IN ORDER WITH NO SEPARATOR, and the readable symbols
	// between them do not separate them either. Measured 2026-08-16, one request per row:
	//
	//   ?cost={Q}W{T}   “{Q}{T}”   the readable {W} between them leaves no trace
	//   ?cost=!W!       “!!”       same, for bare characters
	//   ?cost=!{Q}!     “!{Q}!”    braced and bare interleave in written order
	//   ?cost=a{Q}b     “A{Q}”     `b` is BLACK MANA and readable, so only two fragments
	//
	// This is the one rule here that was first written from a guess: an earlier pass joined the
	// fragments with a space, which no measurement supported and which `{Q}W{T}` disproves. One
	// accumulated string is now the whole mechanism — with an empty separator there is nothing left
	// for a per-fragment merge rule to do.
	let bad = "";
	for (const token of tokens) {
		try {
			total += symbolValue(token.symbol);
		} catch (err) {
			if (!(err instanceof UnparseableSymbol)) throw err;
			bad += reportedFragment(token);
			continue;
		}
		for (const color of symbolColors(token.symbol)) colorSet.add(color);
		if (/^\d+$/.test(token.symbol)) generic += Number.parseInt(token.symbol, 10);
		else if (VARIABLE_PIPS.has(token.symbol)) variables.push(token.symbol);
		else if (COLORLESS_PIPS.has(token.symbol)) colorless.push(token.symbol);
		else colored.push(token.symbol);
	}
	if (bad !== "") {
		throw new ManaCostError(
			`The string fragment(s) “${truncateFragments(bad)}” could not be understood as part of mana cost.`,
		);
	}

	// An empty cost is null, but a cost that was written and happens to be free is `{0}`: Scryfall
	// answers `cost=` with null and `cost=0` with "{0}", so the two cannot share a branch.
	const cost = tokens.length > 0 ? renderCost(variables, generic, colored, colorless, canonicalColors(colorSet)) : null;

	return {
		object: "mana_cost",
		cost,
		colors: WUBRG.filter((color) => colorSet.has(color)),
		cmc: total,
		colorless: colorSet.size === 0,
		monocolored: colorSet.size === 1,
		multicolored: colorSet.size > 1,
	};
}
