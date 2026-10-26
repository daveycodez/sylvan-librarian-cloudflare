// Every printable punctuation character, arithmetic inside a comparison, and a number on the left
// of one — read as api.scryfall.com reads them, on /cards/search and /cards/random only.
//
// Measured 2026-10-25 (Scryfall vs this port): `cmc+1>3` answered 21,932 sums here where Scryfall
// has a 404, `power/2>1` 8,824 halved powers against its 77 and a warning, `1+2`, `t:goblin *`,
// `t:goblin a?b` and 70-odd more shapes of the punctuation sweep a 400 against its answer. The
// totals in the comments are Scryfall's, read that day (anchor `t:goblin` = 561); the harness engine
// is a fake, so these tests assert what REACHES the engine — the tree of a query the deployed
// parser already answers like Scryfall — and the status and warnings, which are decided before it.

import { describe, expect, test } from "bun:test";
import { canonicalStringify, type FilterValue, parseScryfallQuery } from "../../src/parser";
import { LexError } from "../../src/parser/errors";
import { TT, tokenize } from "../../src/parser/tokenizer";
import { SCRYFALL_LEX, scryfallTermPolicy } from "../../src/routes/scryfall-compat/query-terms";
import { FakeEngine, json, makeCtx, testDispatch } from "./harness";

const NO_CARD_VALUE =
	"One or both sides of your comparison must be a card value (\u201cpow\u201d, \u201ctou\u201d, \u201cusd\u201d, \u201ceur\u201d, etc).";
const ignored = (echo: string, reason: string) => `Invalid expression \u201c${echo}\u201d was ignored. ${reason}`;

/** The filter tree a route hands the engine for `q`, with its status and warnings. */
async function reached(
	q: string,
	route = "/cards/search",
): Promise<{ status: number; warnings: unknown; tree: string | undefined; details?: unknown }> {
	const engine = new FakeEngine();
	const response = await testDispatch(makeCtx({ engine }), `${route}?q=${encodeURIComponent(q)}`);
	const body = await json(response);
	const tree = route === "/cards/search" ? engine.lastSearch?.filterTreeJson : engine.lastSampleArgs?.filterTreeJson;
	return { status: response.status, warnings: body.warnings ?? null, tree, details: body.details };
}

/** `q` reaches the engine exactly as `equivalent` does — a query the deployed parser already read. */
async function expectSameSearch(q: string, equivalent: string, warnings: string[] | null = null): Promise<void> {
	const got = await reached(q);
	const want = await reached(equivalent);
	expect(want.status).toBe(200);
	expect({ q, status: got.status, warnings: got.warnings, tree: got.tree }).toEqual({
		q,
		status: 200,
		warnings,
		tree: want.tree,
	});
}

const words = (q: string) =>
	tokenize(q, SCRYFALL_LEX)
		.filter((t) => t.type !== TT.EOF)
		.map((t) => [t.type, String(t.value)]);

describe("the compat lexer reads every punctuation character as Scryfall does", () => {
	test("upstream's lexer — /search's — still refuses them", () => {
		for (const q of ["a?b", "a;b", "a&b", "a|b", "a@b", "a`b", "a$b", "a%b", "a#b", "a^b", "a\\b", '"b', "a{b", "}"]) {
			expect(() => tokenize(q)).toThrow(LexError);
		}
	});

	test("each is one more character of the word it touches, at its start, middle or end", () => {
		for (const c of ["?", ";", "&", "|", "@", "`", "$", "%", "#", "^", "\\", "}", "[", "]", "+", "*"]) {
			expect(words(`a${c}b`)).toEqual([[TT.WORD, `a${c}b`]]);
			expect(words(`${c}b`)).toEqual([[TT.WORD, `${c}b`]]);
			expect(words(`b${c}`)).toEqual([[TT.WORD, `b${c}`]]);
			expect(words(c)).toEqual([[TT.WORD, c]]);
			expect(words(`o:${c}`)).toEqual([
				[TT.WORD, "o"],
				[TT.OP, ":"],
				[TT.WORD, c],
			]);
		}
		expect(words(".b")).toEqual([[TT.WORD, ".b"]]);
		// A number with one glued on is a word, as `2rr` is.
		expect(words("1+2")).toEqual([[TT.WORD, "1+2"]]);
		expect(words("2*3")).toEqual([[TT.WORD, "2*3"]]);
	});

	test("a quote or a brace nothing closes is a character; one that closes is what it was", () => {
		expect(words('"b')).toEqual([[TT.WORD, '"b']]);
		expect(words("'")).toEqual([[TT.WORD, "'"]]);
		expect(words("a{b")).toEqual([[TT.WORD, "a{b"]]);
		expect(words('"b" c')).toEqual([
			[TT.QUOTED, "b"],
			[TT.WORD, "c"],
		]);
		expect(words("{r}")).toEqual([[TT.MANA, "{r}"]]);
		// Glued to the end of a word, a quote is a character even where it closes (`a"b"` is 14).
		expect(words('a"b"')).toEqual([[TT.WORD, 'a"b"']]);
	});

	test("a `!` with nothing glued behind it is a character; glued, it is the exact-name prefix", () => {
		expect(words("b!")).toEqual([[TT.WORD, "b!"]]);
		expect(words("!")).toEqual([[TT.WORD, "!"]]);
		expect(words("!b")).toEqual([
			[TT.BANG, "!"],
			[TT.WORD, "b"],
		]);
		expect(words("b!=1")).toEqual([
			[TT.WORD, "b"],
			[TT.OP, "!="],
			[TT.NUMBER, "1"],
		]);
	});
});

describe("arithmetic is no keyword on Scryfall: a sum compared is one name word", () => {
	test("the reported two: `cmc+1>3` (404) and `power/2>1` (77 and a warning)", async () => {
		expect(scryfallTermPolicy("cmc+1>3")).toMatchObject({ query: '(name:cmc13 name:"c+1")', warnings: [] });
		await expectSameSearch("cmc+1>3 or t:goblin", '(name:cmc13 name:"c+1") or t:goblin'); // 561
		expect(scryfallTermPolicy("power/2>1")).toMatchObject({
			query: "power",
			warnings: [ignored("2>1", NO_CARD_VALUE)],
		});
		await expectSameSearch("power/2>1", "power", [ignored("2>1", NO_CARD_VALUE)]); // 77
	});

	test("its variants", async () => {
		for (const [q, same] of [
			["t:goblin cmc-1>3", "t:goblin name:cmc13"], // 404
			["cmc*2>4 or t:goblin", "name:cmc24 or t:goblin"], // 561
			["pow+tou>5 or t:goblin", '(name:powtou5 name:"w+t") or t:goblin'], // 561
			["t:goblin cmc+1=4", 't:goblin (name:cmc14 name:"c+1" name:"=4")'], // 404
			["pow+1 or t:goblin", '(name:pow1 name:"w+1") or t:goblin'], // 561
			["t:goblin (cmc+1)>3", 't:goblin ((name:cmc1 name:"c+1")) name:3'], // 404
			["(2)>1 or t:goblin", "(name:2) name:1 or t:goblin"], // 564
			["t:goblin (b)>c", "t:goblin (b) name:c"], // 113 = `t:goblin b c`
			["t:goblin -(b)>c", "t:goblin -(b) name:c"], // 97
		] as const) {
			await expectSameSearch(q, same);
		}
		await expectSameSearch("pow/2>1", "pow", [ignored("2>1", NO_CARD_VALUE)]); // 85
		// 404 on Scryfall, whose 404 carries no warnings — and nor does this route's (see the next test).
		for (const [q, same] of [
			["cmc/2>1", "cmc"],
			["t:goblin power/2>1", "t:goblin power"],
			["t:goblin cmc/2>1", "t:goblin cmc"],
			["t:goblin pow/2>1", "t:goblin pow"],
		] as const) {
			await expectSameSearch(q, same, [ignored("2>1", NO_CARD_VALUE)]);
		}
	});

	test("a 404 carries no warnings, as Scryfall's does not", async () => {
		const engine = new FakeEngine();
		engine.cards = [];
		engine.totalCards = 0;
		const response = await testDispatch(makeCtx({ engine }), `/cards/search?q=${encodeURIComponent("cmc/2>1")}`);
		expect(response.status).toBe(404);
		expect((await json(response)).warnings).toBeUndefined();
	});

	test("a number on the left of a comparison", async () => {
		// Against a number or a zero word: ignored with Scryfall's sentence, the term echoed whole.
		for (const term of ["2>1", "1=1", "2:1", "2=x", "-2>1", "2>-1", "2>=1", "2!=1", "2<1", "1.5>1"]) {
			await expectSameSearch(`t:goblin ${term}`, "t:goblin", [ignored(term, NO_CARD_VALUE)]); // 561
		}
		const alone = await reached("2>1");
		expect({ status: alone.status, details: alone.details, warnings: alone.warnings }).toEqual({
			status: 400,
			details: "All of your terms were ignored.",
			warnings: [ignored("2>1", NO_CARD_VALUE)],
		});
		// Against a column it is the comparison turned round, as before (127 and 202).
		expect(scryfallTermPolicy("t:goblin 2<pow").query).toBe("t:goblin 2<pow");
		// Against anything else, the whole term is a name word (each 404).
		for (const [q, same] of [
			["t:goblin 1:b", "t:goblin name:1b"],
			["t:goblin 2:goblin", "t:goblin name:2goblin"],
			["t:goblin 2>a", "t:goblin name:2a"],
			["t:goblin 2a>1", "t:goblin name:2a1"],
		] as const) {
			await expectSameSearch(q, same);
		}
	});
});

describe("`+`, `#`, `^` and `=` are kept by Scryfall's name collation", () => {
	test("`+2` is +2 Mace's 1, `1+2` and `fire+` nothing", () => {
		expect(scryfallTermPolicy("+2").query).toBe('(name:2 name:"+2")');
		expect(scryfallTermPolicy("+2mace").query).toBe('(name:2mace name:"+2")');
		expect(scryfallTermPolicy("1+2").query).toBe('(name:12 name:"1+2")');
		expect(scryfallTermPolicy("fire+").query).toBe('(name:fire name:"e+")');
		expect(scryfallTermPolicy("+").query).toBe('name:"+"');
		expect(scryfallTermPolicy("t:goblin -#").query).toBe('t:goblin -name:"#"');
		expect(scryfallTermPolicy("name:a=b").query).toBe('(name:ab name:"a=b")');
	});

	test("a literal column keeps them as typed", async () => {
		await expectSameSearch("o:+1/+1 t:goblin", 'o:"+1/+1" t:goblin'); // 53
		await expectSameSearch("o:#", 'o:"#"'); // 1
	});
});

describe("a value runs to the next space; a backslash escapes in a value and separates bare words", () => {
	test("text values", () => {
		expect(scryfallTermPolicy("o:,").query).toBe('o:","'); // 22,782
		expect(scryfallTermPolicy("t:goblin o:,haste").query).toBe('t:goblin o:",haste"'); // 404, not o:haste's 90
		expect(scryfallTermPolicy("o:-1/-1").query).toBe('o:"-1/-1"'); // 360
		expect(scryfallTermPolicy("t:go:blin").query).toBe('t:"go:blin"'); // 404
		expect(scryfallTermPolicy("t:goblin o:\\haste").query).toBe("t:goblin o:haste"); // 90
		expect(scryfallTermPolicy("t:go\\blin").query).toBe("t:goblin"); // 561
		expect(scryfallTermPolicy("o:\\").query).toBe("o:\\"); // 404: a trailing backslash stays
	});

	test("bare words", () => {
		expect(scryfallTermPolicy("t:goblin a\\b").query).toBe("t:goblin a b"); // 255
		expect(scryfallTermPolicy("t:goblin \\").query).toBe("t:goblin"); // 561
		expect(scryfallTermPolicy("t:goblin -\\").query).toBe("t:goblin -name:*"); // 404
	});

	test("an unclosed quote ends no term", () => {
		expect(scryfallTermPolicy('"b t:goblin').query).toBe('"b t:goblin'); // 330
		expect(scryfallTermPolicy('o:"haste f:modern').query).toBe('o:"haste f:modern');
	});
});

describe("every shape of the 2026-10-25 punctuation sweep reaches the engine as Scryfall's answer", () => {
	test("each against the query production already answers like Scryfall", async () => {
		for (const [q, same] of [
			["t:goblin a!b", "t:goblin name:ab"], // 200/14
			["t:goblin b!", "t:goblin name:b"], // 200/330
			["t:goblin !", "t:goblin name:*"], // 200/561
			["t:goblin -!", "t:goblin -name:*"], // 404
			["t:goblin name:a!b", "t:goblin name:ab"], // 200/14
			["t:go!blin", 't:"go!blin"'], // 404
			["o:!", 'o:"!"'], // 200/124
			["t:goblin o:!haste", 't:goblin o:"!haste"'], // 404
			['t:goblin a"b', "t:goblin name:ab"], // 200/14
			['t:goblin "b', "t:goblin name:b"], // 200/330
			['t:goblin b"', "t:goblin name:b"], // 200/330
			['t:goblin "', "t:goblin name:*"], // 200/561
			['t:goblin -"', "t:goblin -name:*"], // 404
			['t:goblin name:a"b', "t:goblin name:ab"], // 200/14
			['t:go"blin', "t:'Go\"Blin'"], // 404
			['t:goblin "a"b"', 't:goblin name:"A" name:b'], // 200/255
			['o:"', "o:'\"'"], // 200/1352
			['t:goblin o:"haste', "t:goblin o:'\"haste'"], // 404
			["t:goblin a#b", 't:goblin (name:ab name:"a#b")'], // 404
			["t:goblin #b", 't:goblin (name:b name:"#b")'], // 404
			["t:goblin b#", 't:goblin (name:b name:"b#")'], // 404
			["t:goblin #", 't:goblin name:"#"'], // 404
			["t:goblin -#", 't:goblin -name:"#"'], // 200/561
			["t:goblin name:a#b", 't:goblin (name:ab name:"a#b")'], // 404
			["t:go#blin", 't:"Go#Blin"'], // 404
			["o:#", 'o:"#"'], // 200/1
			["t:goblin o:#haste", 't:goblin o:"#haste"'], // 404
			["t:goblin a$b", "t:goblin name:ab"], // 200/14
			["t:goblin $b", "t:goblin name:b"], // 200/330
			["t:goblin b$", "t:goblin name:b"], // 200/330
			["t:goblin $", "t:goblin name:*"], // 200/561
			["t:goblin -$", "t:goblin -name:*"], // 404
			["t:goblin name:a$b", "t:goblin name:ab"], // 200/14
			["t:go$blin", 't:"Go$Blin"'], // 404
			["o:$", 'o:"$"'], // 404
			["t:goblin o:$haste", 't:goblin o:"$haste"'], // 404
			["t:goblin a%b", "t:goblin name:ab"], // 200/14
			["t:goblin %b", "t:goblin name:b"], // 200/330
			["t:goblin b%", "t:goblin name:b"], // 200/330
			["t:goblin %", "t:goblin name:*"], // 200/561
			["t:goblin -%", "t:goblin -name:*"], // 404
			["t:goblin name:a%b", "t:goblin name:ab"], // 200/14
			["t:go%blin", 't:"Go%Blin"'], // 404
			["o:%", 'o:"%"'], // 200/1
			["t:goblin o:%haste", 't:goblin o:"%haste"'], // 404
			["t:goblin a&b", "t:goblin name:ab"], // 200/14
			["t:goblin &b", "t:goblin name:b"], // 200/330
			["t:goblin b&", "t:goblin name:b"], // 200/330
			["t:goblin &", "t:goblin name:*"], // 200/561
			["t:goblin -&", "t:goblin -name:*"], // 404
			["t:goblin name:a&b", "t:goblin name:ab"], // 200/14
			["t:go&blin", 't:"Go&Blin"'], // 404
			["o:&", 'o:"&"'], // 200/18
			["t:goblin o:&haste", 't:goblin o:"&haste"'], // 404
			["t:goblin 'b", "t:goblin name:b"], // 200/330
			["t:goblin '", "t:goblin name:*"], // 200/561
			["t:goblin -'", "t:goblin -name:*"], // 404
			["o:'", 'o:"\'"'], // 200/8009
			["t:goblin o:'haste", 't:goblin o:"\'haste"'], // 404
			["t:goblin *b", "t:goblin name:b"], // 200/330
			["t:goblin *", "t:goblin name:*"], // 200/561
			["t:goblin a+b", 't:goblin (name:ab name:"a+b")'], // 404
			["t:goblin +b", 't:goblin (name:b name:"+b")'], // 404
			["t:goblin b+", 't:goblin (name:b name:"b+")'], // 404
			["t:goblin +", 't:goblin name:"+"'], // 404
			["t:goblin -+", 't:goblin -name:"+"'], // 200/561
			["t:goblin name:a+b", 't:goblin (name:ab name:"a+b")'], // 404
			["t:go+blin", 't:"Go+Blin"'], // 404
			["o:+", 'o:"+"'], // 200/7615
			["t:goblin o:+haste", 't:goblin o:"+haste"'], // 404
			["t:goblin -,", "t:goblin -name:*"], // 404
			["o:,", 'o:","'], // 200/22782
			["t:goblin o:,haste", 't:goblin o:",haste"'], // 404
			["t:goblin -", "t:goblin -name:*"], // 404
			["t:goblin --", "t:goblin"], // 200/561
			["t:goblin ---", "t:goblin"], // 200/561
			["t:goblin -- b", "t:goblin b"], // 200/330
			["t:goblin - b", "t:goblin -name:* b"], // 404
			["t:goblin b -", "t:goblin b -name:*"], // 404
			["fire - ice", "fire -name:* ice"], // 404 — not `fire -ice`
			["o:-", 'o:"-"'], // 200/1942
			["t:goblin o:-haste", 't:goblin o:"-haste"'], // 404
			["t:goblin .b", "t:goblin name:b"], // 200/330
			["t:goblin .", "t:goblin name:*"], // 200/561
			["t:goblin -.", "t:goblin -name:*"], // 404
			["o:.", 'o:"."'], // 200/32079
			["t:goblin o:.haste", 't:goblin o:".haste"'], // 404
			["t:goblin -/", "t:goblin -name:*"], // 404
			["t:goblin :b", "t:goblin name:b"], // 200/330
			["t:goblin :", "t:goblin name:*"], // 200/561
			["t:goblin -:", "t:goblin -name:*"], // 404
			["t:goblin name:a:b", "t:goblin name:ab"], // 200/14
			["t:go:blin", 't:"go:blin"'], // 404
			["o::", "cmc<0"], // 404, though o:":" is 8,971
			["t:goblin -o::", "t:goblin -cmc<0"], // 561
			["t:goblin name::b", "t:goblin cmc<0"], // 404, though name:<b is b's 330
			["t:goblin name:<b", "t:goblin name:b"], // 330
			["o:x:", 'o:"x:"'], // 27
			['o:":', `o:'":'`], // 3: an unclosed quote is a character of the value
			["o:{t}:", 'o:"{t}:"'], // 3,589
			["t:goblin o::haste", "t:goblin cmc<0"], // 404
			["t:goblin a;b", "t:goblin name:ab"], // 200/14
			["t:goblin ;b", "t:goblin name:b"], // 200/330
			["t:goblin b;", "t:goblin name:b"], // 200/330
			["t:goblin ;", "t:goblin name:*"], // 200/561
			["t:goblin -;", "t:goblin -name:*"], // 404
			["t:goblin name:a;b", "t:goblin name:ab"], // 200/14
			["t:go;blin", 't:"Go;Blin"'], // 404
			["o:;", 'o:";"'], // 200/31
			["t:goblin o:;haste", 't:goblin o:";haste"'], // 404
			["t:goblin <b", "t:goblin name:b"], // 200/330
			["t:goblin <", "t:goblin name:*"], // 200/561
			["t:goblin -<", "t:goblin -name:*"], // 404
			["t:goblin name:a<b", "t:goblin name:ab"], // 200/14
			["t:go<blin", 't:"go<blin"'], // 404
			["o:<", 'o:"<"'], // 404
			["t:goblin o:<haste", 't:goblin o:"<haste"'], // 404
			["t:goblin =b", 't:goblin (name:b name:"=b")'], // 404
			["t:goblin =", 't:goblin name:"="'], // 404
			["t:goblin -=", 't:goblin -name:"="'], // 200/561
			["t:goblin name:a=b", 't:goblin (name:ab name:"a=b")'], // 404
			["t:go=blin", 't:"go=blin"'], // 404
			["o:=", 'o:"="'], // 404
			["t:goblin o:=haste", 't:goblin o:"=haste"'], // 404
			["t:goblin >b", "t:goblin name:b"], // 200/330
			["t:goblin >", "t:goblin name:*"], // 200/561
			["t:goblin ->", "t:goblin -name:*"], // 404
			["t:goblin name:a>b", "t:goblin name:ab"], // 200/14
			["t:go>blin", 't:"go>blin"'], // 404
			["o:>", 'o:">"'], // 404
			["t:goblin o:>haste", 't:goblin o:">haste"'], // 404
			["t:goblin a?b", "t:goblin name:ab"], // 200/14
			["t:goblin ?b", "t:goblin name:b"], // 200/330
			["t:goblin b?", "t:goblin name:b"], // 200/330
			["t:goblin ?", "t:goblin name:*"], // 200/561
			["t:goblin -?", "t:goblin -name:*"], // 404
			["t:goblin name:a?b", "t:goblin name:ab"], // 200/14
			["t:go?blin", 't:"Go?Blin"'], // 404
			["o:?", 'o:"?"'], // 200/7
			["t:goblin o:?haste", 't:goblin o:"?haste"'], // 404
			["t:goblin a@b", "t:goblin name:ab"], // 200/14
			["t:goblin @b", "t:goblin name:b"], // 200/330
			["t:goblin b@", "t:goblin name:b"], // 200/330
			["t:goblin @", "t:goblin name:*"], // 200/561
			["t:goblin -@", "t:goblin -name:*"], // 404
			["t:goblin name:a@b", "t:goblin name:ab"], // 200/14
			["t:go@blin", 't:"Go@Blin"'], // 404
			["o:@", 'o:"@"'], // 404
			["t:goblin o:@haste", 't:goblin o:"@haste"'], // 404
			["t:goblin a[b", "t:goblin name:ab"], // 200/14
			["t:goblin [b", "t:goblin name:b"], // 200/330
			["t:goblin b[", "t:goblin name:b"], // 200/330
			["t:goblin [", "t:goblin name:*"], // 200/561
			["t:goblin -[", "t:goblin -name:*"], // 404
			["t:goblin name:a[b", "t:goblin name:ab"], // 200/14
			["t:go[blin", 't:"Go[Blin"'], // 404
			["o:[", 'o:"["'], // 200/31
			["t:goblin o:[haste", 't:goblin o:"[haste"'], // 404
			["t:goblin a\\b", "t:goblin a b"], // 200/255
			["t:goblin \\b", "t:goblin b"], // 200/330
			["t:goblin b\\", "t:goblin b"], // 200/330
			["t:goblin \\", "t:goblin"], // 200/561
			["t:goblin -\\", "t:goblin -name:*"], // 404
			["t:goblin name:a\\b", "t:goblin name:ab"], // 200/14
			["t:go\\blin", "t:goblin"], // 200/561
			["o:\\", 'o:"\\\\"'], // 404
			["t:goblin o:\\haste", "t:goblin o:haste"], // 200/90
			["t:goblin a]b", "t:goblin name:ab"], // 200/14
			["t:goblin ]b", "t:goblin name:b"], // 200/330
			["t:goblin b]", "t:goblin name:b"], // 200/330
			["t:goblin ]", "t:goblin name:*"], // 200/561
			["t:goblin -]", "t:goblin -name:*"], // 404
			["t:goblin name:a]b", "t:goblin name:ab"], // 200/14
			["t:go]blin", 't:"Go]Blin"'], // 404
			["o:]", 'o:"]"'], // 200/31
			["t:goblin o:]haste", 't:goblin o:"]haste"'], // 404
			["t:goblin a^b", 't:goblin (name:ab name:"a^b")'], // 404
			["t:goblin ^b", 't:goblin (name:b name:"^b")'], // 404
			["t:goblin b^", 't:goblin (name:b name:"b^")'], // 404
			["t:goblin ^", 't:goblin name:"^"'], // 404
			["t:goblin -^", 't:goblin -name:"^"'], // 200/561
			["t:goblin name:a^b", 't:goblin (name:ab name:"a^b")'], // 404
			["t:go^blin", 't:"Go^Blin"'], // 404
			["o:^", 'o:"^"'], // 404
			["t:goblin o:^haste", 't:goblin o:"^haste"'], // 404
			["t:goblin a`b", "t:goblin name:ab"], // 200/14
			["t:goblin `b", "t:goblin name:b"], // 200/330
			["t:goblin b`", "t:goblin name:b"], // 200/330
			["t:goblin `", "t:goblin name:*"], // 200/561
			["t:goblin -`", "t:goblin -name:*"], // 404
			["t:goblin name:a`b", "t:goblin name:ab"], // 200/14
			["t:go`blin", 't:"Go`Blin"'], // 404
			["o:`", 'o:"`"'], // 404
			["t:goblin o:`haste", 't:goblin o:"`haste"'], // 404
			["t:goblin a{b", "t:goblin name:ab"], // 200/14
			["t:goblin {b", "t:goblin name:b"], // 200/330
			["t:goblin b{", "t:goblin name:b"], // 200/330
			["t:goblin {", "t:goblin name:*"], // 200/561
			["t:goblin -{", "t:goblin -name:*"], // 404
			["t:goblin name:a{b", "t:goblin name:ab"], // 200/14
			["t:go{blin", 't:"Go{Blin"'], // 404
			["o:{", 'o:"{"'], // 200/12515
			["t:goblin o:{haste", 't:goblin o:"{haste"'], // 404
			["t:goblin a|b", "t:goblin name:ab"], // 200/14
			["t:goblin |b", "t:goblin name:b"], // 200/330
			["t:goblin b|", "t:goblin name:b"], // 200/330
			["t:goblin |", "t:goblin name:*"], // 200/561
			["t:goblin -|", "t:goblin -name:*"], // 404
			["t:goblin name:a|b", "t:goblin name:ab"], // 200/14
			["t:go|blin", 't:"Go|Blin"'], // 404
			["o:|", 'o:"|"'], // 200/87
			["t:goblin o:|haste", 't:goblin o:"|haste"'], // 404
			["t:goblin a}b", "t:goblin name:ab"], // 200/14
			["t:goblin }b", "t:goblin name:b"], // 200/330
			["t:goblin b}", "t:goblin name:b"], // 200/330
			["t:goblin }", "t:goblin name:*"], // 200/561
			["t:goblin -}", "t:goblin -name:*"], // 404
			["t:goblin name:a}b", "t:goblin name:ab"], // 200/14
			["t:go}blin", 't:"Go}Blin"'], // 404
			["o:}", 'o:"}"'], // 200/12515
			["t:goblin o:}haste", 't:goblin o:"}haste"'], // 404
			["power/2", "name:power name:2"], // 404
			["cmc+1>3 or t:goblin", '(name:cmc13 name:"c+1") or t:goblin'], // 200/561
			["t:goblin cmc+1>3", 't:goblin (name:cmc13 name:"c+1")'], // 404
			["cmc+1", '(name:cmc1 name:"c+1")'], // 404
			["cmc+1 or t:goblin", '(name:cmc1 name:"c+1") or t:goblin'], // 200/561
			[">3 or t:goblin", "name:3 or t:goblin"], // 200/569
			["t:goblin >3", "t:goblin name:3"], // 404
			["t:goblin cmc+1>=3", 't:goblin (name:cmc13 name:"c+1" name:"=3")'], // 404
			["t:goblin cmc-1>3", "t:goblin name:cmc13"], // 404
			["cmc-1>3 or t:goblin", "name:cmc13 or t:goblin"], // 200/561
			["t:goblin cmc*2>4", "t:goblin name:cmc24"], // 404
			["cmc*2>4 or t:goblin", "name:cmc24 or t:goblin"], // 200/561
			["t:goblin pow+tou>5", 't:goblin (name:powtou5 name:"w+t")'], // 404
			["pow+tou>5 or t:goblin", '(name:powtou5 name:"w+t") or t:goblin'], // 200/561
			["t:goblin (cmc+1)>3", 't:goblin ((name:cmc1 name:"c+1")) name:3'], // 404
			["t:goblin power/2", "t:goblin name:power name:2"], // 404
			["t:goblin cmc+1=4", 't:goblin (name:cmc14 name:"c+1" name:"=4")'], // 404
			["t:goblin cmc+1:4", 't:goblin (name:cmc14 name:"c+1")'], // 404
			["pow+1", '(name:pow1 name:"w+1")'], // 404
			["t:goblin pow+1", 't:goblin (name:pow1 name:"w+1")'], // 404
			["t:goblin +", 't:goblin name:"+"'], // 404
			["+", 'name:"+"'], // 200/1
			["t:goblin +b", 't:goblin (name:b name:"+b")'], // 404
			["t:goblin b+", 't:goblin (name:b name:"b+")'], // 404
			["t:goblin a+b", 't:goblin (name:ab name:"a+b")'], // 404
			["+2 mace", '(name:2 name:"+2") mace'], // 200/1
			["+2]", '(name:2 name:"+2")'], // 200/1
			["+2.", '(name:2 name:"+2")'], // 200/1
			["[+2]", '(name:2 name:"+2")'], // 200/1
			["+2,", '(name:2 name:"+2")'], // 200/1
			["name:+2", '(name:2 name:"+2")'], // 200/1
			["t:goblin -+2", 't:goblin -(name:2 name:"+2")'], // 200/561
			["o:+1/+1 t:goblin", 'o:"+1/+1" t:goblin'], // 200/53
			["+1/+1", '(name:1 name:"+1") (name:1 name:"+1")'], // 404
			["t:goblin **", "t:goblin name:*"], // 200/561
			["t:goblin * *", "t:goblin name:*"], // 200/561
			["t:goblin *b", "t:goblin name:b"], // 200/330
			["t:goblin * or t:elf", "(t:goblin name:*) or t:elf"], // 200/1259
			["t:goblin *-b", "t:goblin name:b"], // 200/330
			["3", "name:3"], // 200/8
			[">3", "name:3"], // 200/8
			["<3", "name:3"], // 200/8
			["=3", '(name:3 name:"=3")'], // 404
			["t:goblin >b", "t:goblin name:b"], // 200/330
			["t:goblin <b", "t:goblin name:b"], // 200/330
			["t:goblin =b", 't:goblin (name:b name:"=b")'], // 404
			["t:goblin >=b", 't:goblin (name:b name:"=b")'], // 404
			["t:goblin !=b", 't:goblin (name:b name:"=b")'], // 404
			["t:goblin :b", "t:goblin name:b"], // 200/330
			["t:goblin a*>b", "t:goblin name:ab"], // 200/14
			["t:goblin *a>b", "t:goblin name:ab"], // 200/14
			["t:goblin a*b>c", "t:goblin name:abc"], // 404
			["t:goblin a->b", "t:goblin name:ab"], // 200/14
			["t:goblin a.>b", "t:goblin name:ab"], // 200/14
			["t:goblin a]>b", "t:goblin name:ab"], // 200/14
			["t:goblin a?>b", "t:goblin name:ab"], // 200/14
			["t:goblin ?a>b", "t:goblin name:ab"], // 200/14
			["+2>mace", '(name:2mace name:"+2")'], // 200/1
			["+2>xyz", '(name:2xyz name:"+2")'], // 404
			["+2mace", '(name:2mace name:"+2")'], // 200/1
			["+2>3", '(name:23 name:"+2")'], // 404
			["power*2>1 or t:goblin", "name:power21 or t:goblin"], // 200/561
			["t:goblin power*2>1", "t:goblin name:power21"], // 404
			["power-1>2 or t:goblin", "name:power12 or t:goblin"], // 200/561
			["t:goblin power-1>2", "t:goblin name:power12"], // 404
			["(power)>1 or t:goblin", "(power) name:1 or t:goblin"], // 200/561
			["t:goblin (pow)>1", "t:goblin (pow) name:1"], // 404
			["(cmc+1)>3 or t:goblin", '((name:cmc1 name:"c+1")) name:3 or t:goblin'], // 200/561
			["(2)>1 or t:goblin", "(name:2) name:1 or t:goblin"], // 200/564
			["t:goblin (b)>c", "t:goblin (b) name:c"], // 200/113
			["cmc+1=4 or t:goblin", '(name:cmc14 name:"c+1" name:"=4") or t:goblin'], // 200/561
			["cmc+1:4 or t:goblin", '(name:cmc14 name:"c+1") or t:goblin'], // 200/561
			["pow+1 or t:goblin", '(name:pow1 name:"w+1") or t:goblin'], // 200/561
			["pow*tou>4 or t:goblin", "name:powtou4 or t:goblin"], // 200/561
			["t:goblin 1:b", "t:goblin name:1b"], // 404
			["t:goblin 2a>1", "t:goblin name:2a1"], // 404
			["t:goblin 2>a", "t:goblin name:2a"], // 404
			["t:goblin 2:goblin", "t:goblin name:2goblin"], // 404
			["t:goblin 2>/a/", "t:goblin name:2a"], // 404
			['t:goblin 2>"a"', "t:goblin name:2a"], // 404
			["+e", '(name:e name:"+e")'], // 404
			["s+e", '(name:se name:"s+e")'], // 404
			["2 1", "name:2 name:1"], // 200/3
			["t:goblin t!goblin", "t:goblin name:tgoblin"], // 200/6
			["t:goblin xx!b", "t:goblin name:xxb"], // 404
			["o:-1/-1", 'o:"-1/-1"'], // 200/360
			['"b t:goblin', "name:b t:goblin"], // 200/330
			['t:goblin a"b"', "t:goblin name:ab"], // 200/14
			["t:goblin -(b)>c", "t:goblin -(b) name:c"], // 200/97
			["name:+2mace", '(name:2mace name:"+2")'], // 200/1
			["t:goblin a\\\\b", "t:goblin a b"], // 200/255
			['t:goblin o:\\"haste', "t:goblin o:'\"haste'"], // 404
			["!+2 mace", '!"2" name:mace'], // 404
			["2+", '(name:2 name:"2+")'], // 404
			["t:goblin ->b", "t:goblin -name:b"], // 200/231
			["t:goblin <=b", 't:goblin (name:b name:"=b")'], // 404
			["t:goblin o:a:b", 't:goblin o:"a:b"'], // 404
		] as const) {
			await expectSameSearch(q, same);
		}
	});
});

describe("/cards/random reads them alike", () => {
	test("a punctuation word and an arithmetic chunk", async () => {
		for (const [q, same] of [
			["t:goblin a?b", "t:goblin name:ab"],
			["cmc+1>3 or t:goblin", '(name:cmc13 name:"c+1") or t:goblin'],
		] as const) {
			const got = await reached(q, "/cards/random");
			const want = await reached(same, "/cards/random");
			expect(want.status).toBe(200);
			expect(want.tree).toBeString();
			expect({ q, status: got.status, tree: got.tree }).toEqual({ q, status: 200, tree: want.tree });
		}
	});
});

describe("/search keeps upstream's grammar", () => {
	test("a character upstream's lexer refuses is still its 400", async () => {
		for (const q of ["t:goblin a?b", "+2", "t:goblin *", "o:,", 't:goblin "b', "t:goblin a\\b", "t:goblin =b"]) {
			const response = await testDispatch(makeCtx(), `/search?q=${encodeURIComponent(q)}`);
			expect({ q, status: response.status }).toEqual({ q, status: 400 });
		}
	});

	test("its arithmetic is upstream's, as it was", () => {
		const tree = (q: string) => canonicalStringify(parseScryfallQuery(q) as FilterValue);
		expect(tree("cmc+1>3")).toContain('"op":"+"');
		expect(tree("2>1")).toContain('"NumericValueNode"');
	});
});
