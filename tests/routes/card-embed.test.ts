// The card page answers card.js's two /search calls from the HTML (src/routes/card-embed.ts).
//
// The embed is keyed by the exact URL string card.js passes to fetch(), so these tests RUN card.js
// (the served file, in a stub DOM) rather than trusting the transcription: the URLs it fetches are
// compared to the server's builders, and the page it renders with the embed is compared to the page
// it renders from the network. An upstream sync that changes either fetch fails here instead of
// silently turning the embed off.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineSearchOptions, EngineSerializedResult, ResultShape } from "../../src/engine/types";
import { MAX_QUERY_UTF8_BYTES } from "../../src/parser/query-budget";
import {
	CARD_JS_CARD_FIELDS,
	CARD_JS_PRINTING_FIELDS,
	cardJsTarget,
	embeddedFetchScript,
	escapeExactName,
	printingsUrl,
} from "../../src/routes/card-embed";
import { FakeEngine, makeCtx, testDispatch, useFakeParser } from "./harness";

useFakeParser();

const CARD_JS = readFileSync(join(import.meta.dir, "../../public/static/card.js"), "utf8");
const ORIGIN = "https://sylvan-librarian.com";
const PAGE_CACHE = "public, max-age=0, must-revalidate, s-maxage=3600";

// ── A corpus the fake answers card.js's three query shapes from ──────────────────────────────────
//
// `p` is the row's partition. Corpus order stands in for the engine's sort. war/2a sorts FIRST and
// lives in another partition than war/2 and war/2★, which `cn:"2"` also matches: the shape that
// makes "only rows AT the address are trusted from one partition" testable.

type Row = Record<string, unknown> & { p: number };

const CORPUS: Row[] = [
	{
		p: 4,
		name: "Nissa, Who Shakes the World",
		set_code: "war",
		collector_number: "2a",
		oracle_id: "o-nissa",
		scryfall_id: "00000000-0000-4000-8000-00000000002a",
		type_line: "Legendary Planeswalker — Nissa",
		mana_cost: "{3}{G}{G}",
		oracle_text: "Whenever you tap a Forest for mana, add an additional {G}.",
		set_name: "War of the Spark",
		illustration_id: "ill-nissa",
		price_usd: "3.10",
		prefer_score: 5,
	},
	{
		p: 3,
		name: "Ugin, the Ineffable",
		set_code: "war",
		collector_number: "2",
		oracle_id: "o-ugin",
		scryfall_id: "00000000-0000-4000-8000-000000000002",
		type_line: "Legendary Planeswalker — Ugin",
		mana_cost: "{6}",
		oracle_text: "Colorless spells you cast cost {2} less to cast.",
		set_name: "War of the Spark",
		illustration_id: "ill-ugin",
		price_usd: "1.20",
		prefer_score: 7,
	},
	{
		p: 3,
		name: "Ugin, the Ineffable",
		set_code: "war",
		collector_number: "2★",
		oracle_id: "o-ugin",
		scryfall_id: "00000000-0000-4000-8000-0000000002f0",
		type_line: "Legendary Planeswalker — Ugin",
		mana_cost: "{6}",
		oracle_text: "Colorless spells you cast cost {2} less to cast.",
		set_name: "War of the Spark",
		illustration_id: "ill-ugin-jp",
		price_usd: "9.99",
		prefer_score: 3,
	},
	{
		p: 1,
		name: "Lightning Bolt",
		set_code: "m10",
		collector_number: "146",
		oracle_id: "o-bolt",
		scryfall_id: "00000000-0000-4000-8000-000000000146",
		type_line: "Instant",
		mana_cost: "{R}",
		oracle_text: "Lightning Bolt deals 3 damage to any target.",
		set_name: "Magic 2010",
		illustration_id: "ill-bolt",
		price_usd: "2.00",
		prefer_score: 9,
	},
	{
		p: 1,
		name: "Lightning Bolt",
		set_code: "2xm",
		collector_number: "117",
		oracle_id: "o-bolt",
		scryfall_id: "00000000-0000-4000-8000-000000000117",
		type_line: "Instant",
		mana_cost: "{R}",
		oracle_text: "Lightning Bolt deals 3 damage to any target.",
		set_name: "Double Masters",
		illustration_id: "ill-bolt-2",
		price_usd: "1.00",
		prefer_score: 12,
	},
	{
		p: 2,
		name: "Delver of Secrets // Insectile Aberration",
		set_code: "isd",
		collector_number: "51",
		oracle_id: "o-delver",
		scryfall_id: "00000000-0000-4000-8000-000000000051",
		type_line: "Creature — Human Wizard // Creature — Human Insect",
		mana_cost: "{U}",
		oracle_text: "At the beginning of your upkeep, look at the top card of your library.",
		set_name: "Innistrad",
		power: "1",
		toughness: "1",
		illustration_id: "ill-delver",
		price_usd: "0.50",
		prefer_score: 4,
	},
	// No oracle id: card.js falls back to the exact-name search, whose name needs escaping.
	{
		p: 5,
		name: 'Kongming, "Sleeping Dragon"',
		set_code: "p3k",
		collector_number: "1",
		scryfall_id: "00000000-0000-4000-8000-000000000301",
		type_line: "Legendary Creature — Human Advisor",
		mana_cost: "{2}{W}{W}{W}",
		oracle_text: "Other creatures you control get +1/+1.",
		set_name: "Portal Three Kingdoms",
		power: "2",
		toughness: "2",
		illustration_id: "ill-kongming",
		price_usd: "40.00",
		prefer_score: 2,
	},
	{
		p: 5,
		name: 'Kongming, "Sleeping Dragon"',
		set_code: "me3",
		collector_number: "13",
		scryfall_id: "00000000-0000-4000-8000-000000000313",
		type_line: "Legendary Creature — Human Advisor",
		mana_cost: "{2}{W}{W}{W}",
		oracle_text: "Other creatures you control get +1/+1.",
		set_name: "Masters Edition III",
		power: "2",
		toughness: "2",
		illustration_id: "ill-kongming-2",
		price_usd: "5.00",
		prefer_score: 6,
	},
];

/** The query the fake parser carried into the tree (it stores the query text as a string leaf). */
function queryOf(filterTreeJson: string): string {
	const found: string[] = [];
	const walk = (v: unknown): void => {
		if (typeof v === "string") found.push(v);
		else if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === "object") Object.values(v).forEach(walk);
	};
	walk(JSON.parse(filterTreeJson));
	return found.find((s) => /^(set:|oracleid:|!")/.test(s)) ?? "";
}

function matches(query: string, row: Row): boolean {
	let m = query.match(/^set:(\S+) cn:"((?:[^"\\]|\\.)*)"$/);
	if (m) {
		// `cn:` compares the number's integer part: war/2, war/2a and war/2★ all match `cn:"2"`.
		const wanted = Number.parseInt((m[2] ?? "").replace(/\\(.)/g, "$1"), 10);
		return row.set_code === m[1] && Number.parseInt(String(row.collector_number), 10) === wanted;
	}
	m = query.match(/^oracleid:(\S+)$/);
	if (m) return row.oracle_id === m[1];
	m = query.match(/^!"((?:[^"\\]|\\.)*)"$/);
	if (m) return row.name === (m[1] ?? "").replace(/\\(.)/g, "$1");
	return false;
}

/** Answers card.js's queries from CORPUS, projected onto the requested fields like the engine. */
class CorpusEngine extends FakeEngine {
	searches = 0;
	/** The partition a query is restricted to, or every partition. */
	protected rows(opts: EngineSearchOptions, partition: number | null): Record<string, unknown>[] {
		const query = queryOf(opts.filterTreeJson);
		return CORPUS.filter((r) => (partition === null || r.p === partition) && matches(query, r))
			.slice(0, opts.limit)
			.map((r) => Object.fromEntries((opts.fields ?? []).map((f) => [f, r[f] ?? null])));
	}

	override async searchCardsAsObjects(opts: EngineSearchOptions) {
		this.searches++;
		this.lastSearch = opts;
		if (this.searchError && (this.failOn === null || queryOf(opts.filterTreeJson).startsWith(this.failOn))) {
			throw this.searchError;
		}
		const cards = this.rows(opts, null);
		return { totalCards: cards.length, cards };
	}

	/** Fail only queries starting with this, or every one. */
	failOn: string | null = null;
}

/** CorpusEngine with the routing filter: an address key answers from its partition alone. */
class RoutedEngine extends CorpusEngine {
	addressCalls = 0;
	/** Every address's partition — or, for a key the filter never held, an arbitrary one (0). */
	async searchCardsAtAddress(
		opts: EngineSearchOptions,
		shape: ResultShape,
		addressKey: string,
	): Promise<EngineSerializedResult | null> {
		this.addressCalls++;
		const owner = CORPUS.find((r) => `sn:${r.set_code}/${r.collector_number}` === addressKey);
		const cards = this.rows(opts, owner?.p ?? 0);
		const bytes = new TextEncoder().encode(JSON.stringify(cards));
		expect(shape).toBe("rows");
		return { totalCards: cards.length, cardsBytes: bytes, rowCount: cards.length };
	}
}

// ── card.js, run in a stub DOM ───────────────────────────────────────────────────────────────────

interface Rendered {
	title: string;
	loading: string;
	loadingDisplay: string;
	face: string;
	faceDisplay: string;
	printings: string;
	printingsDisplay: string;
}

type FetchFn = (u: string) => Promise<Response>;

/**
 * Run card.js for `path` in a stub window whose network is `network`, optionally after the page's
 * inline embed script. Returns what the page shows and every URL that reached the network.
 */
async function runCardJs(path: string, network: FetchFn, inlineScript: string | null = null) {
	const fetched: string[] = [];
	const win: { location: { pathname: string }; fetch: FetchFn } = {
		location: { pathname: path },
		fetch: (u) => {
			fetched.push(u);
			return network(u);
		},
	};
	const el = (display = "") => ({
		textContent: "",
		innerHTML: "",
		style: { display },
		addEventListener() {},
		querySelector: () => null,
	});
	const elements: Record<string, ReturnType<typeof el>> = {
		"card-loading": { ...el(), textContent: "Loading..." },
		"card-face": el("none"),
		"other-printings": el("none"),
		"printings-list": el(),
		"site-title": { ...el(), textContent: "Sylvan Librarian" },
		themeToggle: el(),
		themeIcon: el(),
	};
	const document = {
		title: "Sylvan Librarian",
		getElementById: (id: string) => elements[id] ?? null,
		documentElement: { setAttribute() {}, getAttribute: () => "dark" },
	};
	const localStorage = { getItem: () => null, setItem() {} };
	// The flip button waits on an image load that never happens here, which is the same on both runs.
	class Image {
		onload: (() => void) | null = null;
		src = "";
	}
	if (inlineScript !== null) new Function("window", inlineScript)(win);
	const source = CARD_JS.replace(/\nmain\(\);\s*$/, "\nreturn main();");
	expect(source).not.toBe(CARD_JS); // card.js still ends by calling main()
	await new Function("window", "document", "localStorage", "Image", "fetch", source)(
		win,
		document,
		localStorage,
		Image,
		(u: string) => win.fetch(u),
	);
	const at = (id: string) => elements[id] as ReturnType<typeof el>;
	const rendered: Rendered = {
		title: document.title,
		loading: at("card-loading").textContent,
		loadingDisplay: at("card-loading").style.display,
		face: at("card-face").innerHTML,
		faceDisplay: at("card-face").style.display,
		printings: at("printings-list").innerHTML,
		printingsDisplay: at("other-printings").style.display,
	};
	return { rendered, fetched };
}

/** The network as the page sees it today: /search, dispatched against `engine`. */
function searchNetwork(engine: FakeEngine): FetchFn {
	return (u) => testDispatch(makeCtx({ engine, request: new Request(ORIGIN + u) }), u);
}

function page(path: string, engine: FakeEngine | null) {
	return testDispatch(makeCtx({ engine, request: new Request(ORIGIN + path) }), path);
}

/** The body of the page's inline embed script, or null when the page carries none. */
function inlineScriptOf(html: string): string | null {
	const m = html.match(/<script>(\(function\(\)\{var m=[\s\S]*?)<\/script>/);
	return m?.[1] ?? null;
}

function embeddedMap(html: string): Record<string, { cards: Record<string, unknown>[] }> | null {
	const m = html.match(/<script>\(function\(\)\{var m=(.*?);var f=window\.fetch;/);
	return m?.[1] ? JSON.parse(m[1]) : null;
}

// ── card.js's own source ─────────────────────────────────────────────────────────────────────────

describe("card.js's fetches, transcribed", () => {
	test("the source still builds them the way card-embed.ts does", () => {
		// Loud, specific failures for the lines the builders copy; the runs below are the proof.
		expect(CARD_JS).toContain("const parts = window.location.pathname.split('/').filter(Boolean);");
		expect(CARD_JS).toContain("const setCode = rawSetCode.toLowerCase();");
		expect(CARD_JS).toContain("collectorNumber = decodeURIComponent(rawCollectorNumber);");
		expect(CARD_JS).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: card.js's source text, matched verbatim
			"`/search?q=${encodeURIComponent(`set:${setCode} cn:\"${escapeExactName(collectorNumber)}\"`)}&unique=printing&fields=${CARD_FIELDS.join(',')}`",
		);
		expect(CARD_JS).toContain("data.cards?.find(c => c.collector_number === collectorNumber) ?? data.cards?.[0]");
		expect(CARD_JS).toContain(`const printingFields = '${CARD_JS_PRINTING_FIELDS}';`);
		expect(CARD_JS).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: card.js's source text, matched verbatim
			'const printingsQuery = card.oracle_id ? `oracleid:${card.oracle_id}` : `!"${escapeExactName(card.name)}"`;',
		);
		expect(CARD_JS).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: card.js's source text, matched verbatim
			"`/search?q=${encodeURIComponent(printingsQuery)}&unique=printing&fields=${printingFields}`",
		);
		expect(CARD_JS).toContain("return name.replace(/\\\\/g, '\\\\\\\\').replace(/\"/g, '\\\\\"');");
		// CARD_FIELDS, including the port's LOCAL PATCH push, in order.
		const literal = CARD_JS.match(/const CARD_FIELDS = \[([\s\S]*?)\];/)?.[1] ?? "";
		const fields = [...literal.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
		expect(CARD_JS).toContain("CARD_FIELDS.push('scryfall_id');");
		expect([...fields, "scryfall_id"].join(",")).toBe(CARD_JS_CARD_FIELDS);
	});

	test("the path is read raw: the set code stays encoded, the number is decoded and quoted", () => {
		expect(cardJsTarget("/card/WAR/2%E2%98%85")).toEqual({
			setCode: "war",
			collectorNumber: "2★",
			cardUrl: `/search?q=set%3Awar%20cn%3A%222%E2%98%85%22&unique=printing&fields=${CARD_JS_CARD_FIELDS}`,
		});
		// A malformed escape is searched as written, exactly as card.js does.
		expect(cardJsTarget("/card/m10/%E2")?.collectorNumber).toBe("%E2");
		expect(cardJsTarget("/card/m19")).toBeNull();
		expect(escapeExactName('Kongming, "Sleeping Dragon"')).toBe('Kongming, \\"Sleeping Dragon\\"');
	});

	for (const path of ["/card/m10/146", "/card/WAR/2%E2%98%85", "/card/war/2", "/card/p3k/1", "/card/m10/%E2"]) {
		test(`card.js fetches exactly the URLs the server keys: ${path}`, async () => {
			const engine = new CorpusEngine();
			const { fetched } = await runCardJs(path, searchNetwork(engine));
			const target = cardJsTarget(path);
			expect(fetched[0]).toBe(target?.cardUrl as string);
			const first = (await (await searchNetwork(engine)(fetched[0] as string)).json()) as {
				cards: Record<string, unknown>[];
			};
			const picked = first.cards.find((c) => c.collector_number === target?.collectorNumber) ?? first.cards[0] ?? null;
			expect(fetched.slice(1)).toEqual(picked === null ? [] : [printingsUrl(picked) as string]);
		});
	}
});

// ── the inline script ────────────────────────────────────────────────────────────────────────────

describe("the inline fetch shim", () => {
	test("answers each embedded URL once, and everything else from the network", async () => {
		const calls: string[] = [];
		const win = {
			fetch: async (u: string) => {
				calls.push(u);
				return new Response("{}");
			},
		};
		const script = new TextDecoder().decode(
			embeddedFetchScript([{ url: "/a", cards: new TextEncoder().encode('[{"name":"</script>"}]') }]),
		);
		// A `<` in a row cannot close the script early.
		expect(script).not.toContain('</script>"');
		new Function("window", inlineScriptOf(script) as string)(win);
		const body: unknown = await (await win.fetch("/a")).json();
		expect(body).toEqual({ cards: [{ name: "</script>" }] });
		await win.fetch("/a");
		await win.fetch("/b");
		expect(calls).toEqual(["/a", "/b"]);
	});
});

// ── the page ─────────────────────────────────────────────────────────────────────────────────────

describe("card page embedding", () => {
	// The page card.js renders with the embed is the page it renders from the network, and it makes
	// no /search request of its own.
	const CASES: [string, string][] = [
		["/card/m10/146", "an exact printing"],
		["/card/M10/146", "an upper-case set code"],
		["/card/war/2", "an exact printing beside loose `cn:` matches in other partitions"],
		["/card/war/2%E2%98%85", "a ★ number"],
		["/card/isd/51", "a double-faced card"],
		["/card/p3k/1", "no oracle id: the exact-name fallback, escaped"],
		["/card/war/2b", "no printing at the address: card.js's `?? cards[0]`"],
		["/card/zzz/1", "a card that does not exist"],
	];
	for (const Engine of [RoutedEngine, CorpusEngine]) {
		for (const [path, what] of CASES) {
			test(`${Engine.name}: ${what} renders as today, with no fetch (${path})`, async () => {
				const today = await runCardJs(path, searchNetwork(new Engine()));
				const res = await page(path, new Engine());
				expect(res.status).toBe(200);
				expect(res.headers.get("Cache-Control")).toBe(PAGE_CACHE);
				const html = await res.text();
				const after = await runCardJs(path, searchNetwork(new Engine()), inlineScriptOf(html));
				expect(after.fetched).toEqual([]);
				expect(after.rendered).toEqual(today.rendered);
				// And the card really rendered where it exists.
				if (!path.startsWith("/card/zzz")) expect(after.rendered.faceDisplay).toBe("");
			});
		}
	}

	test("the embed sits ahead of the deferred card.js, keyed by card.js's URLs", async () => {
		const html = await (await page("/card/war/2", new RoutedEngine())).text();
		expect(html.indexOf("<script>(function(){var m=")).toBeLessThan(
			html.search(/<script src="\/static\/card\.[0-9a-f]{12}\.js" defer>/),
		);
		const map = embeddedMap(html);
		const first = map?.[cardJsTarget("/card/war/2")?.cardUrl as string];
		// The exact printing only — not war/2a, which sorts first, lives elsewhere, and `cn:` matches.
		expect(first?.cards.map((c) => `${c.set_code}/${c.collector_number}`)).toEqual(["war/2"]);
		const printings = map?.[printingsUrl({ oracle_id: "o-ugin" }) as string];
		expect(printings?.cards.map((c) => c.collector_number)).toEqual(["2", "2★"]);
	});

	test("a routed exact printing is ONE partition call, not a search of every partition", async () => {
		const engine = new RoutedEngine();
		await page("/card/war/2", engine);
		expect(engine.addressCalls).toBe(1);
		expect(engine.searches).toBe(1); // the printings lookup only
		const unrouted = new RoutedEngine();
		await page("/card/war/2b", unrouted);
		expect(unrouted.addressCalls).toBe(1);
		expect(unrouted.searches).toBe(2); // card.js's whole query, then the printings
	});

	test("a query /search refuses embeds nothing, and is cached like any page", async () => {
		// The fake parser refuses PARSE_FAIL, as the real one refuses what card.js cannot quote around.
		const res = await page("/card/m19/PARSE_FAIL", new RoutedEngine());
		expect(res.headers.get("Cache-Control")).toBe(PAGE_CACHE);
		expect(inlineScriptOf(await res.text())).toBeNull();
	});

	test("a collector number past the query budget embeds nothing: dispatch answers card.js's 400", async () => {
		const path = `/card/m19/${"9".repeat(MAX_QUERY_UTF8_BYTES)}`;
		const today = await searchNetwork(new RoutedEngine())(cardJsTarget(path)?.cardUrl as string);
		expect(today.status).toBe(400);
		const res = await page(path, new RoutedEngine());
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe(PAGE_CACHE);
		expect(inlineScriptOf(await res.text())).toBeNull();
	});

	test("an engine fault serves today's page, NOT cached", async () => {
		const engine = new CorpusEngine();
		engine.searchError = new Error("wasm trap");
		const res = await page("/card/m10/146", engine);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(inlineScriptOf(await res.text())).toBeNull();
	});

	test("a failed printings lookup embeds the card alone, NOT cached; card.js fetches the rest", async () => {
		const engine = new RoutedEngine();
		engine.searchError = new Error("wasm trap");
		engine.failOn = "oracleid:";
		const res = await page("/card/m10/146", engine);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		const html = await res.text();
		expect(Object.keys(embeddedMap(html) ?? {})).toEqual([cardJsTarget("/card/m10/146")?.cardUrl as string]);
		const after = await runCardJs("/card/m10/146", searchNetwork(new RoutedEngine()), inlineScriptOf(html));
		expect(after.fetched).toEqual([printingsUrl({ oracle_id: "o-bolt" }) as string]);
		expect(after.rendered).toEqual((await runCardJs("/card/m10/146", searchNetwork(new RoutedEngine()))).rendered);
	});

	test("an unloaded engine is still today's page, not a 503 — and not cached", async () => {
		const res = await page("/card/m10/146", null);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(inlineScriptOf(await res.text())).toBeNull();
	});
});
