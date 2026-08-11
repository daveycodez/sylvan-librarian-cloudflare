// In-query directives (upstream #893): `unique:` / `sort:` / `order:` /
// `direction:` / `dir:` / `prefer:` written inside the query string itself.
//
// The parity corpus covers the shapes upstream's own tests exercise; these pin
// the parts it structurally cannot. A fixture only proves the two parsers agree
// — it says nothing about whether a spelling Scryfall accepts is REACHABLE, and
// the corpus contains no hyphenated `prefer:` case at all.

import { describe, expect, test } from "bun:test";
import { parseScryfallQuery, parseScryfallQueryWithDirectives } from "../../src/parser";
import { CARD_ORDERING, DIRECTIVE_ORDER, DIRECTIVE_PREFER, PREFER_ORDER } from "../../src/routes/enums";
import { applyDirectives } from "../../src/routes/search";

const BASE = { unique: "card", prefer: "default", orderby: "edhrec", direction: "asc" } as const;
const fold = (query: string) => applyDirectives(parseScryfallQueryWithDirectives(query).directives, { ...BASE });

describe("directives are stripped from the filter tree", () => {
	test("a directive leaves no residue, so it cannot reach the engine", () => {
		expect(JSON.stringify(parseScryfallQuery("sort:edhrec t:goblin"))).not.toContain("Directive");
	});

	test("a query of nothing but directives filters as the empty query does", () => {
		expect(parseScryfallQuery("order:name")).toEqual(parseScryfallQuery(""));
	});

	test("stripping does not change what the query matches", () => {
		expect(parseScryfallQuery("t:goblin sort:usd")).toEqual(parseScryfallQuery("t:goblin"));
	});
});

describe("folding follows Scryfall's semantics", () => {
	test("a directive overrides the query parameter, so sort: beats the dropdown", () => {
		expect(fold("sort:name t:goblin").orderby).toBe("name");
	});

	test("the last repeat wins", () => {
		expect(fold("order:name order:usd").orderby).toBe("usd");
	});

	test("Scryfall's unique spellings map onto this port's enum values", () => {
		// UNIQUE_ON is card/printing/artwork; Scryfall writes cards/prints/art.
		expect(fold("unique:prints").unique).toBe("printing");
		expect(fold("unique:art").unique).toBe("artwork");
		expect(fold("unique:cards").unique).toBe("card");
	});

	test("an unknown value warns and is ignored rather than failing the search", () => {
		const folded = fold("t:elf sort:bogus");
		expect(folded.orderby).toBe(BASE.orderby);
		expect(folded.warnings[0]).toContain("bogus");
	});

	test("a nested directive still applies, and says so", () => {
		// It cannot be scoped — a directive shapes the whole result — but written
		// inside an Or or a negation it LOOKS scoped, so it warns.
		expect(fold("t:a or dir:desc").direction).toBe("desc");
		expect(fold("t:a or dir:desc").warnings[0]).toContain("whole search");
		expect(fold("-unique:art t:elf").unique).toBe("artwork");
	});

	test("a parenthesised AND group is not nesting: conjunction is flat", () => {
		expect(fold("(t:goblin sort:usd) t:elf").warnings).toEqual([]);
	});
});

describe("the hyphenated prefer spellings are reachable", () => {
	// The bug this pins: `-` is not a word character in either tokenizer, so
	// `usd-low` lexes as `usd`, `-`, `low`. A directive parser that consumed one
	// token stopped at `usd` and left `-low` to fail the parse — which made the
	// hyphenated keys in the prefer table unreachable from inside a query, by any
	// input. The corpus has no hyphenated prefer case, so parity could not see it.
	test("prefer:usd-low and usd-high parse and map to the enum's underscored values", () => {
		expect(fold("prefer:usd-low t:bolt").prefer).toBe("usd_low");
		expect(fold("prefer:usd-high").prefer).toBe("usd_high");
	});

	test("the underscored spellings keep working", () => {
		expect(fold("prefer:usd_low").prefer).toBe("usd_low");
	});
});

describe("the directive tables are derived, not hardcoded", () => {
	// This is what keeps #893 independent of #913: an ordering added to the enum
	// is accepted as a directive with no second edit. A hardcoded list would turn
	// that free relationship into a real dependency, and would drift silently.
	test("every CardOrdering is a valid order directive", () => {
		for (const ordering of CARD_ORDERING.values) {
			expect(DIRECTIVE_ORDER.get(ordering), `${ordering} must be usable as sort:${ordering}`).toBe(ordering);
		}
		expect(DIRECTIVE_ORDER.size).toBe(CARD_ORDERING.values.length);
	});

	test("every PreferOrder is a valid prefer directive, plus the two aliases", () => {
		for (const prefer of PREFER_ORDER.values) {
			expect(DIRECTIVE_PREFER.get(prefer)).toBe(prefer);
		}
		expect(DIRECTIVE_PREFER.size).toBe(PREFER_ORDER.values.length + 2);
	});
});
