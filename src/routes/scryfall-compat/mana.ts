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
		// A hybrid is worth its more expensive half: {2/W} is 2, {W/U} and {W/P} are 1.
		return Math.max(...symbol.split("/").map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : 1)));
	}
	if (COLORLESS_PIPS.has(symbol) || symbol in COLOR_INDEX) return 1;
	throw new ManaCostError(`The string fragment(s) “{${symbol}}” could not be understood as part of mana cost.`);
}

const BRACED = /^\{([^}]*)\}/;
const DIGITS = /^\d+/;

/**
 * Split a written cost into braced-symbol contents.
 *
 * Unbraced runs are read a character at a time, except digits, which group so `11R` is `{11}{R}`
 * rather than `{1}{1}{R}`.
 */
function tokenize(raw: string): string[] {
	const tokens: string[] = [];
	const upper = raw.toUpperCase();
	let position = 0;
	while (position < upper.length) {
		const rest = upper.slice(position);
		const braced = BRACED.exec(rest);
		if (braced) {
			tokens.push((braced[1] as string).trim());
			position += braced[0].length;
			continue;
		}
		const digits = DIGITS.exec(rest);
		if (digits) {
			tokens.push(digits[0]);
			position += digits[0].length;
			continue;
		}
		const char = upper[position] as string;
		if (!/\s/.test(char)) tokens.push(char);
		position += 1;
	}
	return tokens;
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

	const parts = variables.map((symbol) => `{${symbol}}`);
	if (generic) parts.push(`{${generic}}`);
	parts.push(...ordered.map((symbol) => `{${symbol}}`));
	parts.push(...colorless.map((symbol) => `{${symbol}}`));
	return parts.join("") || "{0}";
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

	for (const token of tokens) {
		total += symbolValue(token);
		for (const color of symbolColors(token)) colorSet.add(color);
		if (/^\d+$/.test(token)) generic += Number.parseInt(token, 10);
		else if (VARIABLE_PIPS.has(token)) variables.push(token);
		else if (COLORLESS_PIPS.has(token)) colorless.push(token);
		else colored.push(token);
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
