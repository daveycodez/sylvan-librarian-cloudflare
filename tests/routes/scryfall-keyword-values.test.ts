// `keyword:` / `kw:` — a value that is no keyword is ignored with Scryfall's sentence, and which
// values are keywords is asked of the store and of the mirrored catalogs, never of a list here.
//
// Every expectation is a measurement on api.scryfall.com, 2026-10-04; the requests are recorded
// beside KEYWORD_ABILITY_KEYWORDS in src/routes/scryfall-compat/query-terms.ts.

import { describe, expect, test } from "bun:test";
import { catalogKey } from "../../src/engine/reference-kv";
import { EMPTY_TAG_ALIASES, parseScryfallQueryWithDirectives } from "../../src/parser";
import {
	type KeywordTables,
	scryfallTermPolicy,
	scryfallTermPolicyFor,
} from "../../src/routes/scryfall-compat/query-terms";
import { FakeEngine, FakeKV, json, makeCtx, testDispatch } from "./harness";

const ignored = (echo: string, reason: string) => `Invalid expression “${echo}” was ignored. ${reason}`;

/** A store whose cards carry these keywords, and Scryfall's catalogs as they stood when measured. */
const CARRIED: Record<string, number> = { Flying: 3990, "First strike": 600, Scry: 300, "10,000 Needles": 1, Pasta: 1 };
const CATALOGS = [
	"Flying",
	"First strike",
	"Absorb",
	"Poisonous",
	"Friends forever",
	"Harness",
	"Untap",
	"Tap",
	"Scry",
];

/** The tables, and how often each was asked. */
function tables(carried: Record<string, number> = CARRIED, catalogs: readonly string[] | null = CATALOGS) {
	const asked = { carried: 0, catalogs: 0 };
	const source: KeywordTables = {
		carried: async () => {
			asked.carried++;
			return carried;
		},
		catalogs: async () => {
			asked.catalogs++;
			return catalogs;
		},
	};
	return { asked, source };
}

const policyFor = (query: string) => scryfallTermPolicyFor(query, tables().source);

describe("a keyword: value that is no keyword is ignored, with a sentence of its own", () => {
	test("alone it is the 400, beside other terms the rest is answered", async () => {
		// `keyword:nonsense` alone is the 400 `All of your terms were ignored.`; `kw:nonsense t:goblin`
		// is `t:goblin`'s 561 carrying the sentence — which has no full stop.
		const alone = await policyFor("keyword:nonsense");
		expect([alone.allIgnored, alone.warnings]).toEqual([
			true,
			[ignored("keyword:nonsense", "Unknown keyword “nonsense”")],
		]);
		const beside = await policyFor("kw:nonsense t:goblin");
		expect([beside.query, beside.warnings]).toEqual([
			"t:goblin",
			[ignored("kw:nonsense", "Unknown keyword “nonsense”")],
		]);
	});

	test("in both polarities, under `=`, quoted, in any case, and under `or`", async () => {
		// `-keyword:untap e:khm` is 305 echoing “-keyword:untap”; `keyword=untap`, `keyword:"untap"`
		// and `keyword:UNTAP` are each the 400; `keyword:untap or t:goblin e:lrw` is the other arm's 27.
		expect((await policyFor("-keyword:nonsense e:khm")).warnings).toEqual([
			ignored("-keyword:nonsense", "Unknown keyword “nonsense”"),
		]);
		expect((await policyFor("keyword=nonsense e:khm")).warnings).toEqual([
			ignored("keyword=nonsense", "Unknown keyword “nonsense”"),
		]);
		expect((await policyFor('keyword:"nonsense" e:khm')).warnings).toEqual([
			ignored('keyword:"nonsense"', "Unknown keyword “nonsense”"),
		]);
		expect((await policyFor("keyword:NONSENSE e:khm")).warnings).toEqual([
			ignored("keyword:nonsense", "Unknown keyword “nonsense”"),
		]);
		expect((await policyFor("keyword:nonsense or t:goblin e:lrw")).query).toBe("t:goblin e:lrw");
	});

	test("a part of a keyword is not one", async () => {
		// `keyword:fly e:khm`, `keyword:"first" e:khm` and `keyword:cumulative` are each ignored.
		for (const value of ["fly", "first", "strike", "needles"]) {
			expect((await policyFor(`keyword:${value} e:khm`)).warnings).toEqual([
				ignored(`keyword:${value}`, `Unknown keyword “${value}”`),
			]);
		}
	});

	test("under a comparison the keyword matches nothing, as it did", async () => {
		// `keyword!=flying e:khm` and `keyword>untap e:khm` are plain 404s.
		expect(await policyFor("keyword>nonsense e:khm")).toMatchObject({ query: "cmc<0 e:khm", warnings: [] });
		expect(await policyFor("keyword!=flying e:khm")).toMatchObject({ query: "cmc<0 e:khm", warnings: [] });
	});
});

describe("a keyword some card carries is one, in a catalog or not", () => {
	test("it is kept as written", async () => {
		// `keyword:flying e:khm` = `keyword:FLYING` = `keyword:"flying"` = `kw:flying` is 25;
		// `keyword:pasta` (no catalog has it) is unk/RZ05e under include:extras.
		for (const term of ["keyword:flying", "kw:flying", "keyword:scry", "keyword:pasta", "-keyword:flying"]) {
			const policy = await policyFor(`${term} e:khm`);
			expect([term, policy.query, policy.warnings]).toEqual([term, `${term} e:khm`, []]);
		}
		expect((await policyFor('keyword:"first strike" e:khm')).query).toBe('keyword:"first strike" e:khm');
	});

	test("with case, spaces and hyphens ignored — and respelled as the store spells it", async () => {
		// `keyword:firststrike e:khm` and `keyword:first-strike e:khm` are 4, as
		// `keyword:"first strike" e:khm` is; both were a 404 here.
		expect((await policyFor("keyword:firststrike e:khm")).query).toBe('keyword:"first strike" e:khm');
		expect((await policyFor("keyword:first-strike e:khm")).query).toBe('keyword:"first strike" e:khm');
		expect((await policyFor("-kw:FirstStrike e:khm")).query).toBe('-kw:"first strike" e:khm');
		expect((await policyFor('keyword:"10,000  needles"')).query).toBe('keyword:"10,000 needles"');
		const respelled = (await policyFor("keyword:first-strike e:khm")).query;
		expect(() => parseScryfallQueryWithDirectives(respelled, EMPTY_TAG_ALIASES)).not.toThrow();
	});
});

describe("a catalog word no card carries is a keyword too, except the nineteen generic actions", () => {
	test("it is kept, and matches nothing", async () => {
		// `keyword:absorb`, `keyword:poisonous`, `keyword:"friends forever"` and `keyword:harness`
		// are plain 404s with no warning, with include:extras as without.
		for (const term of ["keyword:absorb", "keyword:poisonous", 'keyword:"friends forever"', "keyword:harness"]) {
			const policy = await policyFor(`${term} t:sliver`);
			expect([term, policy.query, policy.warnings]).toEqual([term, `${term} t:sliver`, []]);
		}
	});

	test("the generic actions are the unknown sentence though the catalog lists them", async () => {
		// Each asked: abandon activate attach cast counter create destroy discard exchange exile
		// planeswalk play reveal sacrifice "set in motion" shuffle tap untap vote.
		for (const action of [
			...["abandon", "activate", "attach", "cast", "counter", "create", "destroy", "discard", "exchange", "exile"],
			...["planeswalk", "play", "reveal", "sacrifice", "shuffle", "tap", "untap", "vote"],
		]) {
			expect((await policyFor(`keyword:${action} e:khm`)).warnings).toEqual([
				ignored(`keyword:${action}`, `Unknown keyword “${action}”`),
			]);
		}
		expect((await policyFor('keyword:"set in motion" e:khm')).warnings).toEqual([
			ignored('keyword:"set in mot…', "Unknown keyword “set in motion”"),
		]);
		// ...and they need no table at all: the plain policy already says it.
		expect(scryfallTermPolicy("keyword:untap e:khm").warnings).toEqual([
			ignored("keyword:untap", "Unknown keyword “untap”"),
		]);
	});
});

describe("the tables are asked only when a keyword: term needs them", () => {
	test("a query without the keyword asks nothing", async () => {
		const { asked, source } = tables();
		const policy = await scryfallTermPolicyFor("t:goblin e:khm o:keyword", source);
		expect([policy.query, asked]).toEqual(["t:goblin e:khm o:keyword", { carried: 0, catalogs: 0 }]);
		expect(scryfallTermPolicy("t:goblin e:khm").asksKeywords).toBeUndefined();
	});

	test("a keyword a card carries asks the store alone; one no card carries asks the catalogs too", async () => {
		const carried = tables();
		await scryfallTermPolicyFor("keyword:flying e:khm", carried.source);
		expect(carried.asked).toEqual({ carried: 1, catalogs: 0 });
		const uncarried = tables();
		await scryfallTermPolicyFor("keyword:absorb e:khm", uncarried.source);
		expect(uncarried.asked).toEqual({ carried: 1, catalogs: 1 });
		// A comparison, a pattern and a generic action are answered without either.
		const none = tables();
		await scryfallTermPolicyFor("keyword>flying keyword:/fly/ keyword:untap e:khm", none.source);
		expect(none.asked).toEqual({ carried: 0, catalogs: 0 });
	});

	test("the plain policy says which table a term is waiting on", () => {
		expect(scryfallTermPolicy("keyword:flying e:khm").asksKeywords).toBe("carried");
		const keywords = new Map([["flying", "flying"]]);
		expect(scryfallTermPolicy("keyword:flying e:khm", { keywords }).asksKeywords).toBeUndefined();
		expect(scryfallTermPolicy("keyword:absorb e:khm", { keywords }).asksKeywords).toBe("catalog");
	});

	test("a table that could not say validates nothing: the term is kept, never dropped", async () => {
		// An empty store table (an engine that could not say) and unreadable catalogs both leave
		// the term to match nothing — narrower than Scryfall, never the wider answer a drop is.
		const emptyStore = await scryfallTermPolicyFor("keyword:nonsense e:khm", tables({}, CATALOGS).source);
		expect([emptyStore.query, emptyStore.warnings]).toEqual(["keyword:nonsense e:khm", []]);
		const noCatalogs = await scryfallTermPolicyFor("keyword:nonsense e:khm", tables(CARRIED, null).source);
		expect([noCatalogs.query, noCatalogs.warnings]).toEqual(["keyword:nonsense e:khm", []]);
	});
});

describe("through /cards/search, against the store's own keywords and the mirrored catalogs", () => {
	const kv = () => {
		const store = new FakeKV();
		store.put(catalogKey("keyword-abilities"), JSON.stringify(["Flying", "Absorb", "Poisonous"]));
		store.put(catalogKey("keyword-actions"), JSON.stringify(["Scry", "Untap", "Harness"]));
		store.put(catalogKey("ability-words"), JSON.stringify(["Landfall"]));
		return store;
	};
	const engine = () => {
		const fake = new FakeEngine();
		fake.keywords = { Flying: 2, Scry: 1 };
		return fake;
	};

	test("an unknown keyword alone is the 400 carrying the sentence", async () => {
		const res = await testDispatch(makeCtx({ engine: engine(), kv: kv() }), "/cards/search?q=keyword%3Anonsense");
		expect(res.status).toBe(400);
		expect(await json(res)).toMatchObject({
			details: "All of your terms were ignored.",
			warnings: [ignored("keyword:nonsense", "Unknown keyword “nonsense”")],
		});
	});

	test("a catalog word no card carries is searched, not dropped", async () => {
		const fake = engine();
		const res = await testDispatch(makeCtx({ engine: fake, kv: kv() }), "/cards/search?q=keyword%3Aabsorb");
		expect(fake.lastSearch).not.toBeNull();
		expect((await json(res)).warnings).toBeUndefined();
	});
});
