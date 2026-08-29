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
//   - Emission order is X, then generic, then every other pip in `GET /symbology` catalog order,
//     regardless of input order, with generic summed into one symbol: `2XWU` is `{X}{2}{W}{U}`, and
//     `1{1}` is `{2}`. `PIP_ORDER` is that rule.

/** The colour wheel. Every canonical ordering is a walk around this cycle. */
const WUBRG = ["W", "U", "B", "R", "G"] as const;
const COLOR_INDEX: Record<string, number> = Object.fromEntries(WUBRG.map((color, index) => [color, index]));

/** Mana that is not a colour: colorless and snow. */
const COLORLESS_PIPS = new Set(["C", "S"]);

/** Variable pips, which contribute nothing to mana value. */
const VARIABLE_PIPS = new Set(["X", "Y", "Z"]);

/**
 * Half-mana symbols are written {HW}; the half applies to the symbol after the H. `GET /symbology`
 * lists exactly these two (2026-08-28), and reading `H` as a prefix over any colour was one symbol
 * too generous: `?cost={HB}` is a 422 on api.scryfall.com, measured the same day.
 */
const HALF_SYMBOLS = new Set(["HW", "HR"]);
const HALF_MANA = 0.5;

/**
 * Every hybrid symbol api.scryfall.com knows, in the order `GET /symbology` lists them.
 *
 * Fetched whole on 2026-08-28: 84 symbols, 36 of them hybrids, and this is all 36. The inventory is
 * the rule — a hybrid parses if and only if it is one of these — because no rule stated in terms of
 * the halves gets the boundary right. This port used to require exactly TWO halves, which rejects
 * the ten PHYREXIAN HYBRIDS below: `{W/U/P}` and its nine siblings are printed symbols, and four
 * live cards carry one in their mana cost (`is:phyrexian is:hybrid`, 2026-08-28 — Ajani, Sleeper
 * Agent `{1}{G}{G/W/P}{W}`; Tamiyo, Compleated Sage `{2}{G}{G/U/P}{U}`; Nahiri, the Unforgiving
 * `{1}{R}{R/W/P}{W}`; Lukka, Bound to Ruin `{2}{R}{R/G/P}{G}`). Loosening the count to "two or
 * three" would be just as wrong in the other direction: `{W/U/B}` and `{3/W}` are still 422s.
 *
 * The order is load-bearing twice over — it is also the order hybrids are EMITTED in, see PIP_ORDER.
 */
const HYBRID_SYMBOLS = [
	// Colour pairs.
	"W/U",
	"W/B",
	"B/R",
	"B/G",
	"U/B",
	"U/R",
	"R/G",
	"R/W",
	"G/W",
	"G/U",
	// Phyrexian hybrids — one of two colours, or 2 life. All ten colour pairs exist.
	"B/G/P",
	"B/R/P",
	"G/U/P",
	"G/W/P",
	"R/G/P",
	"R/W/P",
	"U/B/P",
	"U/R/P",
	"W/B/P",
	"W/U/P",
	// Colorless hybrids.
	"C/W",
	"C/U",
	"C/B",
	"C/R",
	"C/G",
	// Twobrid.
	"2/W",
	"2/U",
	"2/B",
	"2/R",
	"2/G",
	// Phyrexian.
	"W/P",
	"U/P",
	"B/P",
	"R/P",
	"G/P",
	"C/P",
] as const;

/**
 * Every SPELLING that names one of those symbols, mapped to the spelling Scryfall answers with.
 *
 * A two-part hybrid may be written either way round and comes back canonical — measured one request
 * each on 2026-08-28, once per family: `{U/W}`→`{W/U}`, `{W/2}`→`{2/W}`, `{P/W}`→`{W/P}`,
 * `{W/C}`→`{C/W}`. A three-part one may NOT: `{U/W/P}` and `{P/W/U}` are both 422s where `{W/U/P}`
 * parses, so the ten Phyrexian hybrids are accepted only as spelled above.
 */
const HYBRID_CANONICAL = new Map<string, string>(
	HYBRID_SYMBOLS.flatMap((symbol) => {
		const parts = symbol.split("/");
		const spellings: [string, string][] = [[symbol, symbol]];
		if (parts.length === 2) spellings.push([`${parts[1]}/${parts[0]}`, symbol]);
		return spellings;
	}),
);

/**
 * The order pips are EMITTED in: `GET /symbology` catalog order, for everything a cost can carry
 * besides generic and variable pips (fetched 2026-08-28).
 *
 * Measured, one request per row on 2026-08-28, each written both ways round to prove it is a sort
 * and not the writing order:
 *
 *   ?cost={G}{G/W}{W}    {G/W}{G}{W}     a hybrid comes out ahead of a plain pip of its colour
 *   ?cost={W}{HW}        {HW}{W}         so does a half pip
 *   ?cost={R}{HR}{R/W}   {R/W}{HR}{R}    and a hybrid comes out ahead of a half pip
 *   ?cost={W}{C/P}       {C/P}{W}        a colourless hybrid sorts with the hybrids, not at the end
 *   ?cost={S}{C}         {C}{S}          the colorless pips have an order of their own
 *
 * Between two hybrids it is THIS list's order and not the colour order, which is the one thing a
 * colour-rank sort cannot express: `{G/W}{W/U}` answers `{W/U}{G/W}` and `{G/U}{W/B}` answers
 * `{W/B}{G/U}`, both of which put the later colour first. Same for half pips: `{HR}{HW}` answers
 * `{HW}{HR}` though Boros orders R before W.
 *
 * The five PLAIN colour pips are the exception, and the only one: `RUW` answers `{U}{R}{W}`, so they
 * come out in canonical colour order rather than catalog order. They occupy five consecutive catalog
 * slots, so ranking them within that block says exactly that — see `PLAIN_PIP_AT`.
 */
const PIP_ORDER: string[] = [...HYBRID_SYMBOLS, "HW", "HR", "W", "U", "B", "R", "G", "C", "S"];
const PIP_INDEX = new Map(PIP_ORDER.map((symbol, index) => [symbol, index]));
const PLAIN_PIP_AT = PIP_INDEX.get("W") as number;

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
	if (HALF_SYMBOLS.has(symbol)) return HALF_MANA;
	if (symbol.includes("/")) {
		// A hybrid parses if and only if it is one of the 36 symbols Scryfall lists — see
		// HYBRID_SYMBOLS for why the inventory rather than a rule about the halves.
		const canonical = HYBRID_CANONICAL.get(symbol);
		if (canonical === undefined) throw new UnparseableSymbol();
		// A hybrid is worth its most expensive part: {2/W} is 2, {W/U}, {W/U/P} and {C/P} are 1.
		return Math.max(...canonical.split("/").map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : 1)));
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
 *
 * What counts as "could read" is exactly the ten ONE-CHARACTER mana symbols — the five colours,
 * `{C}`, `{S}` and the three variables. `P`, `H` and digits are NOT struck, which this used to get
 * wrong by inferring the set from what the parser prices rather than measuring it. Five more rows,
 * one request each on 2026-08-28, all of them costs the inventory above now rejects:
 *
 *   ?cost={U/W/P}     “{//P}”    a Phyrexian hybrid spelled backwards — the P survives
 *   ?cost={2/W/P}     “{2//P}”   and so does the generic half
 *   ?cost={3/W}       “{3/}”     there is no {3/W}; only {2/X} twobrids exist
 *   ?cost={H/W}       “{H/}”     H survives too
 *   ?cost={HB}        “{H}”      there is no {HB} either; only {HW} and {HR}
 */
function reportedFragment(token: Token): string {
	if (!token.braced) return token.spelling;
	const residue = [...token.symbol]
		.filter((ch) => !(ch in COLOR_INDEX) && !COLORLESS_PIPS.has(ch) && !VARIABLE_PIPS.has(ch))
		.join("");
	return `{${residue}}`;
}

/**
 * Assemble the normalized cost string. A cost whose symbols all cancel to nothing renders as `{0}`.
 */
function renderCost(variables: string[], generic: number, pips: string[], colors: string[]): string {
	const rank = new Map(colors.map((color, index) => [color, index]));
	// Catalog order, with the five plain colour pips ranked inside their own block of the catalog so
	// that they alone come out in canonical colour order. Every pip that reaches here is a symbol
	// Scryfall lists, so the lookup always hits.
	const sortKey = (symbol: string, at: number): [number, number] => {
		const own = rank.get(symbol);
		return [own === undefined ? (PIP_INDEX.get(symbol) ?? PIP_ORDER.length) : PLAIN_PIP_AT + own, at];
	};
	const ordered = pips
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
	// One list for every pip that is neither generic nor variable — colored, colorless and hybrid
	// alike — because their emission order is one catalog order and not three buckets: `{W}{C/P}`
	// answers `{C/P}{W}`, so a colourless hybrid comes out AHEAD of a coloured pip.
	const pips: string[] = [];
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
		// A hybrid is emitted in the spelling Scryfall answers with, not the one it was written in.
		else pips.push(HYBRID_CANONICAL.get(token.symbol) ?? token.symbol);
	}
	if (bad !== "") {
		throw new ManaCostError(
			`The string fragment(s) “${truncateFragments(bad)}” could not be understood as part of mana cost.`,
		);
	}

	// An empty cost is null, but a cost that was written and happens to be free is `{0}`: Scryfall
	// answers `cost=` with null and `cost=0` with "{0}", so the two cannot share a branch.
	const cost = tokens.length > 0 ? renderCost(variables, generic, pips, canonicalColors(colorSet)) : null;

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
