// Broad differential sweep: this mirror against api.scryfall.com, hunting UNKNOWN divergences.
//
//   bun scripts/parity-sweep.ts [--origin <url>] [--only <substr>] [--group <name>] [--limit N]
//                               [--no-pages] [--no-objects] [--gap <ms>] [--out <dir>] [--key <k>]
//
// The default origin is a local dev server, where the per-IP limiter is not enforced. Point
// --origin at the DEPLOYMENT and it is: export TRUSTED_API_KEY first (see live-parity.ts's header
// for why a keyless remote run is refused rather than allowed to report 429s as divergences).
//
// scripts/live-parity.ts pins ~46 KNOWN shapes byte-for-byte; its job is regression, and every case
// in it is a shape someone already looked at. This script is the opposite instrument: a SYSTEMATIC
// matrix generated from the vocabularies themselves — every `DB_COLUMNS` alias, every `order=`,
// every `unique=`, every `dir=`, booleans, multilingual, realistic user queries — run against both
// origins to find divergences nobody has looked at yet.
//
// The primary oracle is deliberately NOT the card object: it is
//
//     total_cards, has_more, and THE FULL ORDERED LIST OF `data[].id`
//
// because results are merged bytewise across partitions (src/engine/gather.ts) and an ordering bug
// there is silent — every field of every card is right and the sequence is wrong. The ordered id
// list catches that for one request per query, which is the cheapest strong signal available.
//
// Ordering is analyzed separately from membership, because the two fail for different reasons and
// only one of them is a bug in this repo:
//
//   * MEMBERSHIP — an id one side returns and the other does not. On a query whose whole result
//     fits one page this is exact; past 175 rows it is entangled with ordering (a single misplaced
//     row shifts the window). Membership divergence is corpus vintage far more often than logic:
//     the local store is built from a Scryfall bulk dump, api.scryfall.com is live. Every
//     scryfall-only id is therefore probed against OUR /cards/:id — absent from the store means
//     vintage, present in the store means the filter dropped it, which is a real finding.
//   * ORDERING — the relative order of the ids BOTH sides returned. That comparison is immune to
//     vintage: it only looks at rows both corpora have. A reordering of the common subsequence is
//     the sorting oracle, and it is what the two-phase gather can silently break.
//
// Card objects are then compared byte-exactly, for free: when the id lists agree, the objects are
// already in hand, so the sweep runs live-parity's reduction pipeline over the first few cards of
// each page and aggregates the differing paths across the whole run. No extra Scryfall requests.
//
// Every divergence is CLASSIFIED, never merely reported:
//
//   KNOWN        — covered by scripts/live-parity-cases.json (a field_deviation path, or the
//                  Scryfall-only key ledger). Cited by deviation name.
//   IN-FLIGHT    — matches a family under active repair right now (IN_FLIGHT below).
//   VINTAGE      — explained by the store being built from an older bulk dump than the live API.
//   UNSUPPORTED  — a Scryfall search operator this port does not implement, probed on purpose.
//   NEW          — everything else. These are the deliverable.
//
// Politeness to api.scryfall.com is non-negotiable and stricter than live-parity's, because several
// agents share the budget: serial requests, a 250ms floor between them, Retry-After honored with
// backoff, a browser-identifying UA, and a per-day on-disk response cache SHARED WITH live-parity
// (same directory, same key derivation) so a path either harness already fetched today is free.
//
// Standalone script, NOT a test under tests/ — bunfig pins the test root and tests/ holds a
// no-network invariant this file exists to violate on purpose.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The port's OWN catalog list drives the `/catalog/*` coverage, so a name added here without being
// added upstream (or the reverse) shows up as a divergence rather than as a case nobody wrote.
import { CATALOG_NAMES } from "../src/engine/reference-kv";
import { DB_COLUMNS, type FieldInfo } from "../src/parser/db-info";
import { foldAccents } from "../src/parser/pystr";
import {
	CARD_ORDERING,
	type CardOrdering,
	resolveDirection,
	SORT_DIRECTION,
	type SortDirection,
} from "../src/routes/enums";
import { stringifyScryfall } from "../src/routes/scryfall-compat/respond";
import {
	checkVolatileShape,
	newVolatileShapeTally,
	volatileShapeRunProblems,
	volatileShapeSummary,
} from "./volatile-shape";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCRYFALL_ORIGIN = "https://api.scryfall.com";
const DEFAULT_ORIGIN = "http://localhost:8787";

/** Identifies this project to Scryfall; a generic agent gets 403'd. */
const USER_AGENT = "sylvan-parity-sweep/1.0 (+https://github.com/jbylund/sylvan_librarian)";

/**
 * The per-IP limiter's bypass key, read from the environment — NEVER written down here.
 *
 * Same gap live-parity.ts had: a few hundred cache-missing engine requests from one address is
 * exactly what the limiter exists to stop, so a keyless run against the deployment answers 429 and
 * this harness would file every one as an unknown divergence — the loudest possible way to report
 * an auth problem. `TRUSTED_API_KEY` / `X-API-Key` is the convention load-test.ts and
 * bench-cards-search.ts already use, checked against the Worker's `TRUSTED_API_KEYS` LIST by
 * `isTrustedRequest` (src/routes/rate-limit.ts) — one key per caller, revocable alone.
 */
const TRUSTED_KEY_ENV = "TRUSTED_API_KEY";
const TRUSTED_KEY_HEADER = "X-API-Key";

/** Origins the limiter never runs on, so a key is genuinely unnecessary. */
function isLocalOrigin(url: string): boolean {
	try {
		const { hostname } = new URL(url);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}

/** Minimum spacing between requests to api.scryfall.com. Above live-parity's 100ms on purpose. */
const DEFAULT_GAP_MS = 250;

/** Shared with scripts/live-parity.ts — same directory, same key derivation, so cache hits cross. */
const CACHE_ROOT =
	process.env.LIVE_PARITY_CACHE_DIR ??
	"/private/tmp/claude-501/-Users-david-Developer-sylvan-librarian-cloudflare/1f7f7129-b296-412e-9176-54db930fba01/scratchpad/live-parity-cache";

const DEFAULT_OUT_DIR =
	"/private/tmp/claude-501/-Users-david-Developer-sylvan-librarian-cloudflare/1f7f7129-b296-412e-9176-54db930fba01/scratchpad";

/** Scryfall's page size, and therefore the modulus every page-boundary question is asked in. */
const PAGE_SIZE = 175;

/** How many card objects per page get the byte-exact treatment. */
const OBJECT_SAMPLE = 3;

/**
 * Volatile leaf keys stripped from BOTH sides anywhere they appear (live-parity, plan C4).
 *
 * The reduction below it — nulling `prices` and cutting the image cache-buster — hid three real
 * bugs from BOTH harnesses for their whole life, so what it erases is checked structurally instead
 * by scripts/volatile-shape.ts; see that file's header before widening any of this.
 *
 * These two keys are erased HARDER than a price is: `prices` keeps its keys and only loses its
 * values, so a missing price key still fails the byte comparison, while these are deleted key and
 * all from both sides. volatile-shape.ts's run-level check is the only thing that would notice
 * either of them going permanently dark.
 */
const VOLATILE_KEYS = ["edhrec_rank", "penny_rank"];

/** Tracking params api.scryfall.com decorates purchase/related URIs with; the bulk data has none. */
const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "referrer", "affiliate_id", "ref", "subId1"];

// ─── flags ────────────────────────────────────────────────────────────────────

let origin = DEFAULT_ORIGIN;
let only: string | undefined;
let group: string | undefined;
let limit = Number.POSITIVE_INFINITY;
let runPages = true;
let runObjects = true;
let gapMs = DEFAULT_GAP_MS;
let outDir = DEFAULT_OUT_DIR;
let trustedKey: string | undefined = process.env[TRUSTED_KEY_ENV] || undefined;
/**
 * Write the generated matrix to a file and exit WITHOUT running it — the corpus as data, for
 * harnesses that want these queries against a different oracle. scripts/search-differential.ts is
 * the one that does: it runs `/search` against `/cards/search` on one local store, so `/search`
 * gets exercised by the same operator × polarity × value-form grid this file builds. Reusing the
 * matrix is the point; a second hand-written query list would drift from this one immediately.
 */
let dumpCases: string | undefined;

{
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const value = () => {
			const v = args[++i];
			if (v === undefined) throw new Error(`${arg} needs a value`);
			return v;
		};
		if (arg === "--origin") origin = value().replace(/\/+$/, "");
		else if (arg === "--only") only = value();
		else if (arg === "--group") group = value();
		else if (arg === "--limit") limit = Number(value());
		else if (arg === "--no-pages") runPages = false;
		else if (arg === "--no-objects") runObjects = false;
		else if (arg === "--gap") gapMs = Number(value());
		else if (arg === "--out") outDir = value();
		else if (arg === "--key") trustedKey = value();
		else if (arg === "--dump-cases") dumpCases = value();
		else throw new Error(`unknown flag: ${arg}`);
	}
}

// A REMOTE origin with no key is refused BEFORE any case runs, for the reason in live-parity.ts:
// discovering it case by case turns a missing export into a page of invented divergences.
// `--dump-cases` runs no case at all, so it is exempt — the matrix is generated, not fetched.
if (!trustedKey && !isLocalOrigin(origin) && !dumpCases) {
	console.error(`parity-sweep: ${origin} enforces a per-IP rate limit, and no bypass key was given.`);
	console.error("");
	console.error(`  export ${TRUSTED_KEY_ENV}=<one of the Worker's TRUSTED_API_KEYS>   # then re-run`);
	console.error("  # or pass --key <k> for a one-off; the default origin is a local dev server, which needs neither");
	console.error("");
	console.error("Without it every case answers 429 and the sweep files rate limiting as divergences.");
	process.exit(2);
}

// ─── polite Scryfall fetch with a per-day cache (live-parity's machinery) ─────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Fetched {
	status: number;
	body: string;
	/**
	 * Response headers, lowercased — present only for a fetch that ASKED for them.
	 *
	 * The `routes`/`formats`/`http` families compare `Content-Type`, `Cache-Control`,
	 * `Content-Disposition` and `x-scryfall-has-more`, which the query families never look at. The
	 * field is optional so the on-disk cache stays the shape scripts/live-parity.ts writes: an entry
	 * either harness stored today is still a hit for a body-only fetch, and a header-bearing fetch
	 * treats a header-less entry as a miss and upgrades it in place (see `fetchScryfall`).
	 */
	headers?: Record<string, string>;
}

let lastScryfallAt = 0;
let scryfallRequests = 0;
let cacheHits = 0;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheFileFor(method: string, path: string, body: string | undefined): string {
	const day = new Date().toISOString().slice(0, 10);
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`${method} ${path}\n${body ?? ""}`);
	const key = hasher.digest("hex").slice(0, 24);
	return join(CACHE_ROOT, day, `${key}.json`);
}

async function fetchScryfall(path: string, method = "GET", body?: string, wantHeaders = false): Promise<Fetched> {
	const cacheFile = cacheFileFor(method, path, body);
	if (existsSync(cacheFile)) {
		// An unparseable entry is treated as a MISS, not as an exception. The writer below is atomic
		// now, but live-parity.ts shares this directory and any entry written before it was is still
		// on disk — and a cache read that throws does not fail loudly, it fails as a divergence filed
		// against an innocent case (`SyntaxError: Unterminated string` on whatever query wanted that
		// path). Re-fetching costs one request and cannot lie.
		let cached: Fetched | undefined;
		try {
			cached = JSON.parse(readFileSync(cacheFile, "utf8")) as Fetched;
		} catch {
			cached = undefined;
		}
		// A header-less entry (this harness before today, or live-parity's own writes) cannot answer
		// a header question, so it is re-fetched and REPLACED with the fuller record rather than
		// stored beside it — one entry per request, and the upgrade is paid once per day at most.
		if (cached && (!wantHeaders || cached.headers !== undefined)) {
			cacheHits++;
			return cached;
		}
	}

	for (let attempt = 0; ; attempt++) {
		const wait = lastScryfallAt + gapMs - Date.now();
		if (wait > 0) await sleep(wait);
		lastScryfallAt = Date.now();
		scryfallRequests++;
		const res = await fetch(`${SCRYFALL_ORIGIN}${path}`, {
			method,
			headers: {
				accept: "application/json",
				"user-agent": USER_AGENT,
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body,
			// A `format=image` answer IS its 302, and its `Location` is the payload; following it
			// would fetch a JPEG off the CDN and compare pictures.
			redirect: "manual",
		});
		if (res.status === 429 && attempt < 6) {
			// Scryfall's 429 body says 60s; Retry-After is authoritative when present. Back off
			// hard — several agents share this budget today and a network block is unrecoverable.
			const retryAfter = Number(res.headers.get("retry-after") ?? "") || 20 * (attempt + 1);
			console.log(`    (429 from Scryfall; sleeping ${retryAfter}s)`);
			await res.arrayBuffer();
			await sleep(retryAfter * 1000);
			continue;
		}
		const fetched: Fetched = { status: res.status, body: await bodyText(res), headers: headersOf(res) };
		mkdirSync(dirname(cacheFile), { recursive: true });
		// WRITE THEN RENAME, because a killed run must not poison the cache. A `writeFileSync`
		// interrupted part-way leaves a TRUNCATED entry at a key every later run reads as a hit, and
		// the JSON parse failure surfaces as `SyntaxError: Unterminated string` filed against whatever
		// case happened to want that path — five invented divergences from one ^C, each pointing at an
		// innocent query. rename(2) within a directory is atomic, so an entry is either absent or
		// whole. The `.tmp` name carries the pid so two harnesses writing the same key cannot collide.
		const tempFile = `${cacheFile}.${process.pid}.tmp`;
		writeFileSync(tempFile, JSON.stringify(fetched));
		renameSync(tempFile, cacheFile);
		return fetched;
	}
}

/** Response headers as a lowercased map — the fetch API already lowercases the names. */
function headersOf(res: Response): Record<string, string> {
	const out: Record<string, string> = {};
	res.headers.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}

async function fetchOurs(path: string, method = "GET", body?: string): Promise<Fetched> {
	const res = await fetch(`${origin}${path}`, {
		method,
		headers: {
			accept: "application/json",
			"cache-control": "no-cache",
			// UNCOMPRESSED, deliberately. `format=image` answers a bodyless 302 that still advertises
			// `Content-Encoding: gzip`, and Bun decompresses eagerly inside `fetch` — so the call
			// THREW `ZlibError` on the empty body before anything could decide not to read it. The
			// origin is localhost or the deployment's own host, so the bytes are free either way.
			"accept-encoding": "identity",
			// Ours only — api.scryfall.com never sees this header.
			...(trustedKey ? { [TRUSTED_KEY_HEADER]: trustedKey } : {}),
			...(body !== undefined ? { "content-type": "application/json" } : {}),
		},
		body,
		redirect: "manual",
	});
	// A 429 here means the key is missing from (or absent in) the Worker's TRUSTED_API_KEYS, and
	// every remaining case would answer the same way. Stop rather than fill the report with
	// divergences that are really auth.
	if (res.status === 429) {
		await bodyText(res);
		console.error("");
		console.error(`parity-sweep: ${origin} answered 429 on ${method} ${path}.`);
		console.error(
			trustedKey
				? `  ${TRUSTED_KEY_HEADER} was sent but not accepted — check the key is in the Worker's TRUSTED_API_KEYS list.`
				: `  No ${TRUSTED_KEY_HEADER} was sent; export ${TRUSTED_KEY_ENV} and re-run.`,
		);
		console.error("  Aborting: the remaining cases would be filed as divergences.");
		process.exit(2);
	}
	return { status: res.status, body: await bodyText(res), headers: headersOf(res) };
}

/**
 * A response's body as text, treating a redirect's as empty.
 *
 * `format=image` answers a bodyless 302, and both origins still advertise `Content-Encoding: gzip`
 * on it — so decoding the (zero-byte) body throws `ZlibError` rather than returning "". The body of
 * a redirect is not the answer anyway; the `Location` is, and that is compared as a header.
 */
async function bodyText(res: Response): Promise<string> {
	if (res.status >= 300 && res.status < 400) return "";
	return res.text();
}

// ─── live-parity's reductions, verbatim in behavior ───────────────────────────
//
// Mirrors scripts/live-parity.ts §"the reductions". Kept as a copy rather than a shared module so
// this sweep cannot change the behavior of the committed regression harness while it runs.

function isObject(v: Json | undefined): v is { [key: string]: Json } {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function compilePattern(pattern: string): string[] {
	return pattern.includes(".") ? pattern.split(".") : ["**", pattern];
}

function matchFrom(pattern: string[], pi: number, path: string[], si: number): boolean {
	if (pi === pattern.length) return si === path.length;
	const seg = pattern[pi] as string;
	if (seg === "**") {
		for (let k = si; k <= path.length; k++) if (matchFrom(pattern, pi + 1, path, k)) return true;
		return false;
	}
	if (si >= path.length) return false;
	if (seg !== "*" && seg !== path[si]) return false;
	return matchFrom(pattern, pi + 1, path, si + 1);
}

function anyPatternMatches(patterns: string[][], path: string[]): boolean {
	return patterns.some((p) => matchFrom(p, 0, path, 0));
}

function substituteOrigin(v: Json): Json {
	if (typeof v === "string") return v.startsWith(origin) ? `${SCRYFALL_ORIGIN}${v.slice(origin.length)}` : v;
	if (Array.isArray(v)) return v.map(substituteOrigin);
	if (isObject(v)) {
		const out: { [key: string]: Json } = {};
		for (const [k, val] of Object.entries(v)) out[k] = substituteOrigin(val);
		return out;
	}
	return v;
}

function stripVolatileSpecials(v: Json): Json {
	if (Array.isArray(v)) return v.map(stripVolatileSpecials);
	if (!isObject(v)) return v;
	const out: { [key: string]: Json } = {};
	for (const [k, val] of Object.entries(v)) {
		if (k === "prices" && isObject(val)) {
			const prices: { [key: string]: Json } = {};
			for (const key of Object.keys(val)) prices[key] = null;
			out[k] = prices;
		} else if (k === "image_uris" && isObject(val)) {
			const images: { [key: string]: Json } = {};
			for (const [key, u] of Object.entries(val)) images[key] = typeof u === "string" ? (u.split("?")[0] ?? u) : u;
			out[k] = images;
		} else {
			out[k] = stripVolatileSpecials(val);
		}
	}
	return out;
}

function stripPatternKeys(v: Json, patterns: string[][], path: string[] = []): Json {
	if (Array.isArray(v)) return v.map((item, i) => stripPatternKeys(item, patterns, [...path, String(i)]));
	if (!isObject(v)) return v;
	const out: { [key: string]: Json } = {};
	for (const [k, val] of Object.entries(v)) {
		const here = [...path, k];
		if (anyPatternMatches(patterns, here)) continue;
		out[k] = stripPatternKeys(val, patterns, here);
	}
	return out;
}

function stripAffiliateDecoration(v: Json, underUris = false): Json {
	if (Array.isArray(v)) return v.map((item) => stripAffiliateDecoration(item, underUris));
	if (isObject(v)) {
		const out: { [key: string]: Json } = {};
		for (const [k, val] of Object.entries(v))
			out[k] = stripAffiliateDecoration(val, underUris || k === "purchase_uris" || k === "related_uris");
		return out;
	}
	if (!underUris || typeof v !== "string") return v;
	let text = v;
	try {
		let url = new URL(text);
		if (url.hostname === "partner.tcgplayer.com") {
			const unwrapped = url.searchParams.get("u");
			if (unwrapped) {
				text = unwrapped;
				url = new URL(text);
			}
		}
		let changed = false;
		for (const param of TRACKING_PARAMS) {
			if (url.searchParams.has(param)) {
				url.searchParams.delete(param);
				changed = true;
			}
		}
		if (changed) text = url.toString();
	} catch {
		return v;
	}
	return text;
}

function sortKeysDeep(v: Json): Json {
	if (Array.isArray(v)) return v.map(sortKeysDeep);
	if (!isObject(v)) return v;
	const out: { [key: string]: Json } = {};
	for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k] as Json);
	return out;
}

function canonical(v: Json): string {
	return stringifyScryfall(sortKeysDeep(v));
}

function excerpt(v: Json | undefined): string {
	const text = v === undefined ? "(absent)" : stringifyScryfall(v);
	return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

interface Diff {
	path: string[];
	kind: "value" | "missing-ours" | "missing-scryfall" | "array-length";
	scryfall: Json | undefined;
	ours: Json | undefined;
}

function collectDiffs(scryfall: Json, ours: Json, path: string[], out: Diff[]): void {
	if (isObject(scryfall) && isObject(ours)) {
		for (const k of new Set([...Object.keys(scryfall), ...Object.keys(ours)])) {
			const here = [...path, k];
			if (!(k in ours)) out.push({ path: here, kind: "missing-ours", scryfall: scryfall[k], ours: undefined });
			else if (!(k in scryfall)) out.push({ path: here, kind: "missing-scryfall", scryfall: undefined, ours: ours[k] });
			else collectDiffs(scryfall[k] as Json, ours[k] as Json, here, out);
		}
		return;
	}
	if (Array.isArray(scryfall) && Array.isArray(ours)) {
		if (scryfall.length !== ours.length)
			out.push({ path, kind: "array-length", scryfall: scryfall.length, ours: ours.length });
		const n = Math.min(scryfall.length, ours.length);
		for (let i = 0; i < n; i++) collectDiffs(scryfall[i] as Json, ours[i] as Json, [...path, String(i)], out);
		return;
	}
	if (canonical(scryfall) !== canonical(ours)) out.push({ path, kind: "value", scryfall, ours });
}

// ─── the ledger: scripts/live-parity-cases.json is the single source of KNOWN ──

interface FieldDeviation {
	name: string;
	note: string;
	paths: string[];
	normalize?: string;
	cases?: string[];
}

interface CasesFile {
	scryfall_only_keys: string[];
	field_deviations: FieldDeviation[];
	cases: { name: string; path: string }[];
}

const casesFile = JSON.parse(readFileSync(join(repoRoot, "scripts/live-parity-cases.json"), "utf8")) as CasesFile;
const ledgerPatterns = casesFile.scryfall_only_keys.map(compilePattern);
const volatilePatterns = VOLATILE_KEYS.map(compilePattern);

/**
 * Which committed field_deviation covers this path, if any.
 *
 * The `cases` scoping in the file is deliberately IGNORED here: it exists so a layout-specific
 * divergence cannot absorb the same path going wrong on a pinned case, which is a regression-suite
 * concern. This sweep runs queries that file has never seen, so a path the file documents as
 * divergent is documented, full stop — reporting it as NEW would be noise.
 */
function knownDeviationFor(path: string[]): FieldDeviation | undefined {
	for (const deviation of casesFile.field_deviations) {
		const patterns = deviation.paths.map(compilePattern);
		for (let len = path.length; len >= 1; len--) {
			if (anyPatternMatches(patterns, path.slice(0, len))) return deviation;
		}
	}
	return undefined;
}

// ─── IN-FLIGHT: families under active repair while this sweep runs ────────────

interface InFlightFamily {
	name: string;
	note: string;
	/** Object paths this family owns. */
	paths?: string[];
	/** List-level predicate: does this case's divergence belong to the family? */
	listMatch?: (c: SweepCase) => boolean;
}

const IN_FLIGHT: InFlightFamily[] = [
	{
		name: "multiface-card-object",
		note: "multiface card-object family (mana_cost / image_uris / hoisted top-level face fields / related_uris name)",
		// The paths the concurrent working tree is editing right now (git diff of
		// src/routes/scryfall-compat/objects.ts at the time of the run): the hoisted top-level face
		// fields, the printed_* triple, produced_mana, and the per-layout image/related_uris rules.
		// `**.image_uris` was in this list and is deliberately NOT any more. It suppressed the
		// whole subtree, and the subtree was five keys short of Scryfall's on every card object
		// this mirror served (thumb/grid/display/art/crop — see IMAGE_EXTENSIONS in
		// scryfall-compat/objects.ts). An in-flight entry hides the field it names for as long as
		// it stands, so it must name a difference somebody is actually holding open; this one
		// outlived the repair it was written for and turned into a blindfold.
		paths: [
			"**.mana_cost",
			"**.card_back_id",
			"**.illustration_id",
			"**.power",
			"**.toughness",
			"**.loyalty",
			"**.flavor_text",
			"**.watermark",
			"**.produced_mana",
			"**.printed_name",
			"**.printed_type_line",
			"**.printed_text",
			"**.related_uris.edhrec",
			"**.related_uris.tcgplayer_infinite_articles",
			"**.related_uris.tcgplayer_infinite_decks",
			"**.related_uris.gatherer",
		],
	},
	{
		name: "all-parts-per-printing",
		note: "all_parts is per-printing upstream, per-card here",
		paths: ["**.all_parts"],
	},
	{ name: "keywords-casing", note: "keywords casing", paths: ["**.keywords"] },
	{
		name: "color-games-order",
		note: "color / games array order",
		paths: ["**.colors", "**.color_identity", "**.games"],
	},
	{
		name: "order-set-collector-number",
		note: "order=set collector-number ordering",
		listMatch: (c) => /[?&]order=set(&|$)/.test(c.path) || /order:set|sort:set/.test(c.path),
	},
	{
		name: "khm-ja-representative",
		note: "the khm ja representative residue",
		listMatch: (c) => /lang%3Aja/.test(c.path) && /khm/.test(c.path),
	},
	{
		name: "oracleid-operator",
		note: "the missing `oracleid:` operator",
		listMatch: (c) => /oracleid|oracle_id/.test(c.path),
	},
	{
		name: "zero-uuid-validation",
		note: "zero-UUID validation",
		listMatch: (c) => /00000000-0000-0000-0000-000000000000/.test(c.path),
	},
	{ name: "fuzzy-slack", note: "the fuzzy-slack cases", listMatch: (c) => /[?&]fuzzy=/.test(c.path) },
	{
		name: "collection-has-more",
		note: "collection has_more",
		listMatch: (c) => c.path.startsWith("/cards/collection"),
	},
	{ name: "rulings-same-date-order", note: "rulings same-date order", listMatch: (c) => /\/rulings/.test(c.path) },
];

function inFlightForPath(path: string[]): InFlightFamily | undefined {
	for (const family of IN_FLIGHT) {
		if (!family.paths) continue;
		const patterns = family.paths.map(compilePattern);
		for (let len = path.length; len >= 1; len--) {
			if (anyPatternMatches(patterns, path.slice(0, len))) return family;
		}
	}
	return undefined;
}

function inFlightForCase(c: SweepCase): InFlightFamily | undefined {
	return IN_FLIGHT.find((f) => f.listMatch?.(c));
}

// ─── the matrix ───────────────────────────────────────────────────────────────

interface SweepCase {
	name: string;
	group: string;
	path: string;
	/** Vocabulary items this case is the coverage evidence for. */
	covers: string[];
	/** Probing an operator this port is not expected to implement. */
	unsupported?: boolean;
}

const cases: SweepCase[] = [];
const seenPaths = new Set<string>();

function add(name: string, groupName: string, path: string, covers: string[], unsupported = false): void {
	if (seenPaths.has(path)) return;
	seenPaths.add(path);
	cases.push({ name, group: groupName, path, covers, unsupported });
}

function search(q: string, params: Record<string, string> = {}): string {
	const usp = new URLSearchParams({ q, ...params });
	return `/cards/search?${usp.toString()}`;
}

/**
 * Representative values per DB column, by dbColumnName.
 *
 * `eq` values are equality probes (one query each, on the column's PRIMARY alias); `neg` drives the
 * negation probe; `cmp` the comparison probes, only for columns whose parser class orders values;
 * `quoted` a phrase with a space, which is the quoting path; `regex` the `/.../` path Scryfall
 * supports on the text columns. Absent entries mean "this column has no searchable alias" (the
 * table is keyed off DB_COLUMNS itself below, so a column added upstream shows up as a MISSING
 * VALUES warning rather than silently dropping out of coverage).
 *
 * THE SET ANCHORS IN THIS TABLE ARE CHECKED, not chosen once and trusted. `e:khm` was the default
 * anchor for years and KHM has no transform printing at all, so all three layout probes compared an
 * empty list against an empty list and read `ok` throughout the period the per-face layout data was
 * wrong. Eight anchors here were measured vacuous the first time `anchorProbes` ran — `e:tsp` has no
 * 2015 frame, `e:khm` no Goblin and no $0.02 printing, `e:nph` no `wm:none`, `e:dom` no "the
 * multiverse" flavor line — and are re-anchored below. A `neg` anchor is held to more: the anchor
 * must be SPLIT by the feature, because a set every row of which matches answers 0 under an honored
 * negation and 0 under a dropped one, which is the exact shape of the family that went unseen.
 */
const VALUES: Record<string, { eq: string[]; neg?: string; cmp?: string[]; quoted?: string; regex?: string }> = {
	card_artist: { eq: ["a:guay"], neg: "-a:guay", quoted: 'a:"rebecca guay"' },
	card_colors: { eq: ["c:rg", "c:colorless"], neg: "-c:w t:goblin", cmp: ["c>=uw t:instant", "c<wubrg t:dragon"] },
	card_color_identity: { eq: ["ci:wu t:instant"], neg: "-ci:c e:khm", cmp: ["ci<=wubr e:dom t:legendary"] },
	card_frame_data: { eq: ["frame:1997 t:goblin", "frame:future"], neg: "-frame:2015 e:tsr" },
	card_keywords: { eq: ["kw:cascade", "keyword:flying e:khm"], neg: "-kw:flying t:angel" },
	card_name: {
		eq: ["name:bolt"],
		neg: "-name:the t:dragon r:mythic",
		quoted: 'name:"lightning bolt"',
		regex: "name:/^Ancient/",
	},
	card_subtypes: { eq: ["subtype:eldrazi"], neg: "-subtype:human t:cleric" },
	card_types: { eq: ["t:planeswalker r:mythic", "t:legendary t:artifact e:bro"], neg: "-t:creature e:khm" },
	cmc: { eq: ["cmc:16", "mv:0 t:creature e:khm"], neg: "-cmc:3 e:lea", cmp: ["cmc>=13", "mv<1 t:artifact e:mh1"] },
	creature_power: { eq: ["pow:12"], neg: "-pow:2 t:dwarf e:khm", cmp: ["pow>=13", "power<0"] },
	creature_toughness: { eq: ["tou:13"], neg: "-tou:1 t:elf e:khm", cmp: ["tou>=14", "toughness<1"] },
	planeswalker_loyalty: { eq: ["loy:7"], neg: "-loy:3 t:planeswalker e:war", cmp: ["loyalty>=6"] },
	mana_cost_jsonb: {
		eq: ["m:{R}{R}{R}", "mana:{2}{W}{W} t:enchantment"],
		neg: "-m:{U} t:merfolk e:lci",
		cmp: ["m>={3}{G}{G}{G} t:elf"],
	},
	devotion: { eq: ["devotion:{u}{u}{u}{u}"], neg: "-devotion:{r} t:dwarf e:khm" },
	price_usd: { eq: ["usd:0.15 e:khm"], neg: "-usd:0.15 e:khm", cmp: ["usd>=500", "usd<0.30 e:khm t:land"] },
	price_eur: { eq: ["eur:0.02 e:khm"], cmp: ["eur>=400", "eur<0.30 e:khm t:elf"] },
	price_tix: { eq: ["tix:0.02 e:khm"], cmp: ["tix>=40", "tix<0.05 e:khm t:land"] },
	produced_mana: { eq: ["produces:wubrg", "produces:c t:land e:khm"], neg: "-produces:g t:land e:khm" },
	oracle_text: {
		eq: ["o:cascade", "o:proliferate t:instant"],
		neg: "-o:flying t:bird",
		quoted: 'o:"draw two cards" e:khm',
		regex: "o:/^Whenever you cast/ e:khm",
	},
	flavor_text: { eq: ["ft:dominaria t:legendary"], neg: "-ft:the e:lea", quoted: 'ft:"the multiverse"' },
	card_oracle_tags: {
		eq: ["otag:removal e:khm", "function:ramp e:khm", "oracletag:counterspell e:khm", "oracle_tags:draw e:khm"],
		neg: "-otag:removal e:khm t:instant",
	},
	card_art_tags: {
		eq: ["art:dragon e:khm", "atag:skull e:khm", "arttag:snow e:khm", "art_tags:forest e:khm"],
		neg: "-art:human e:khm t:creature",
	},
	card_is_tags: {
		eq: ["is:split", "is:commander e:khm", "is:promo e:khm", "is:reprint e:khm", "is:permanent e:khm t:legendary"],
		neg: "-is:reprint e:khm r:mythic",
	},
	card_rarity_int: {
		eq: ["r:mythic e:khm", "rarity:bonus"],
		neg: "-r:common e:khm t:dwarf",
		cmp: ["r>=rare e:khm t:creature", "r<uncommon e:khm t:land"],
	},
	card_set_code: { eq: ["e:lea t:land", "s:khm t:god", "set:tsp t:legendary"], neg: "-e:khm t:god" },
	collector_number: { eq: ["cn:1 t:land", "number:250 e:khm"], cmp: ["cn>=380 e:khm", "cn<3 e:lea"] },
	card_legalities: {
		eq: [
			"f:pauper t:dwarf r:common e:khm",
			"legal:standard e:khm t:god",
			"banned:legacy",
			"restricted:vintage",
			"format:premodern t:goblin",
		],
		neg: "-f:commander e:khm",
	},
	card_lang: { eq: ["lang:ja e:khm t:god", "lang:any e:khm t:god"], neg: "-lang:en e:khm t:god" },
	card_layout: { eq: ["layout:transform e:mid", "layout:saga e:khm"], neg: "-layout:normal e:mid" },
	card_border: { eq: ["border:borderless e:khm", "border:silver t:goblin"], neg: "-border:black e:sld" },
	card_watermark: { eq: ["wm:izzet t:instant", "watermark:mirran"], neg: "-wm:phyrexian e:nph t:creature" },
	released_at: {
		eq: ["date:2021-02-05 t:god", "year:1993 t:land"],
		cmp: ["date>=2026-01-01 t:god", "year<1994 t:legendary", "date<=1994-04-01 t:land"],
	},
};

/** Columns with no search alias at all — nothing to probe, and the sweep says so rather than lying. */
const NO_ALIAS_COLUMNS = new Set(["edhrec_rank", "raw_card_blob"]);

const columnsCovered: string[] = [];
const aliasesCovered: string[] = [];

for (const col of DB_COLUMNS as readonly FieldInfo[]) {
	if (col.searchAliases.length === 0) {
		if (!NO_ALIAS_COLUMNS.has(col.dbColumnName))
			console.log(`  ! ${col.dbColumnName} has no aliases and is not ledgered`);
		continue;
	}
	const spec = VALUES[col.dbColumnName];
	if (!spec) {
		console.log(`  ! MISSING VALUES for ${col.dbColumnName} (aliases ${col.searchAliases.join(",")})`);
		continue;
	}
	columnsCovered.push(col.dbColumnName);
	const primary = col.searchAliases[0] as string;

	for (const [i, q] of spec.eq.entries()) {
		add(`op-${col.dbColumnName}-eq${i}`, "operators", search(q), [`${col.dbColumnName}:eq`]);
	}
	if (spec.neg) add(`op-${col.dbColumnName}-neg`, "operators", search(spec.neg), [`${col.dbColumnName}:negation`]);
	for (const [i, q] of (spec.cmp ?? []).entries())
		add(`op-${col.dbColumnName}-cmp${i}`, "operators", search(q), [`${col.dbColumnName}:comparison`]);
	if (spec.quoted)
		add(`op-${col.dbColumnName}-quoted`, "operators", search(spec.quoted), [`${col.dbColumnName}:quoted`]);
	if (spec.regex) add(`op-${col.dbColumnName}-regex`, "operators", search(spec.regex), [`${col.dbColumnName}:regex`]);

	// Alias equivalence: every alias of the column, spelled against the same value the primary
	// alias used, so a synonym wired to the wrong column shows up as a different answer.
	const sample = spec.eq[0] as string;
	for (const alias of col.searchAliases) {
		aliasesCovered.push(alias);
		if (alias === primary) continue;
		const swapped = sample.replace(new RegExp(`(^|\\s)${primary}([:<>=])`), `$1${alias}$2`);
		if (swapped === sample) continue;
		add(`alias-${col.dbColumnName}-${alias}`, "aliases", search(swapped), [`alias:${alias}`]);
	}
}

// ── boolean combinations ──
const BOOLEAN_QUERIES: [string, string][] = [
	["and-two", "t:goblin r:rare"],
	["and-three", "t:goblin r:rare c:r"],
	["or-flat", "t:goblin or t:elf e:khm"],
	["or-three", "e:khm (t:god or t:giant or t:elf)"],
	["not-of-or", "e:khm -(t:creature or t:land)"],
	["nested-parens", "e:khm (t:creature (c:u or c:g)) -kw:flying"],
	["deep-nesting", "e:khm ((c:u t:creature) or (c:r t:instant)) -r:common"],
	["or-across-columns", "e:khm (o:draw or kw:flying) t:creature"],
	["negated-or-group", "t:dragon -(e:khm or e:m21)"],
	["double-negation", "e:khm -(-t:creature)"],
	["and-or-precedence", "e:khm t:creature or t:land"],
	["explicit-and-keyword", "e:khm t:creature and c:u"],
	["mixed-case-operators", "E:KHM T:Creature OR T:Land"],
	["negated-quoted-phrase", 'e:khm -o:"draw a card"'],
	["not-prefix-bang", "e:khm t:creature -is:reprint"],
	["exact-name-bang", '!"Lightning Bolt"'],
	["exact-name-bang-quoted-multi", '!"Fire // Ice"'],
	["parens-single-term", "(e:khm)"],
	["redundant-parens", "((( e:khm t:god )))"],
	["or-with-negation-inside", "e:khm (t:god or -t:creature) r:rare"],
];
for (const [name, q] of BOOLEAN_QUERIES) add(`bool-${name}`, "booleans", search(q), [`boolean:${name}`]);

// ── order × dir, on frozen corpora ──
//
// Every ordering, both directions, plus the omitted (auto) direction, on a SET-SCOPED query with
// `unique=prints`. Set scoping freezes the corpus (a released set never gains printings), so an id
// list that differs is a sorting fact and not a vintage fact; `unique=prints` maximizes ties
// (many printings share a name, a release date, a rarity), and ties are exactly where an opaque
// sort key's tiebreak suffix has to agree with Scryfall's.
const ORDER_BASE = "e:khm";
const orderCovered: string[] = [];
for (const order of CARD_ORDERING.values) {
	orderCovered.push(order);
	for (const dir of SORT_DIRECTION.values) {
		add(`order-${order}-${dir}`, "ordering", search(ORDER_BASE, { order, dir, unique: "prints" }), [
			`order:${order}`,
			`dir:${dir}`,
		]);
	}
	add(`order-${order}-nodir`, "ordering", search(ORDER_BASE, { order, unique: "prints" }), [
		`order:${order}:default-dir`,
	]);
}
// Scryfall's two orderings this port does not implement, and a nonsense one: all three should warn
// and fall back rather than error.
for (const order of ["penny", "review", "bogus"])
	add(
		`order-unsupported-${order}`,
		"ordering",
		search(ORDER_BASE, { order, unique: "prints" }),
		[`order:${order}`],
		true,
	);
add("order-dir-bogus", "ordering", search(ORDER_BASE, { order: "name", dir: "sideways", unique: "prints" }), [
	"dir:bogus",
]);
// A second frozen corpus for the orderings whose khm values are near-uniform.
for (const order of ["released", "set", "rarity", "cmc", "artist", "color", "name", "usd"])
	add(`order2-${order}`, "ordering", search("e:lea", { order, unique: "prints" }), [`order:${order}:second-corpus`]);
// Ties on purpose: one artist, one date, one rarity across many sets.
for (const order of ["artist", "released", "rarity", "cmc"])
	add(`order-ties-${order}`, "ordering", search('a:"rebecca guay"', { order, unique: "prints" }), [
		`order:${order}:ties`,
	]);

// ── unique modes ──
const UNIQUE_SPELLINGS = ["cards", "card", "prints", "printing", "printings", "art", "artwork", "bogus"];
for (const unique of UNIQUE_SPELLINGS)
	add(
		`unique-${unique}`,
		"unique",
		search("e:khm t:god", { unique, order: "name" }),
		[`unique:${unique}`],
		unique === "bogus",
	);
for (const unique of ["cards", "prints", "art"])
	add(`unique-multi-${unique}`, "unique", search('!"Lightning Bolt"', { unique, order: "released" }), [
		`unique:${unique}:reprints`,
	]);

// ── multilingual ──
const LANGS = ["ja", "es", "de", "fr", "it", "pt", "ru", "ko", "zhs", "zht", "la", "ph"];
for (const lang of LANGS) {
	add(`lang-${lang}`, "multilingual", search(`lang:${lang} e:khm t:god`, { order: "name", unique: "prints" }), [
		`lang:${lang}`,
	]);
}
for (const im of ["true", "false"]) {
	add(
		`multilingual-${im}`,
		"multilingual",
		search("e:khm t:god", { include_multilingual: im, order: "name", unique: "prints" }),
		[`include_multilingual:${im}`],
	);
	add(
		`multilingual-cards-${im}`,
		"multilingual",
		search("e:khm t:god", { include_multilingual: im, order: "name", unique: "cards" }),
		[`include_multilingual:${im}:unique-cards`],
	);
}
add("lang-any-broad", "multilingual", search("lang:any e:khm cn:1", { unique: "prints", order: "name" }), ["lang:any"]);
add("lang-negated", "multilingual", search("-lang:en e:khm t:god", { unique: "prints", order: "name" }), [
	"lang:negated",
]);
add(
	"lang-with-multilingual",
	"multilingual",
	search("lang:ja e:khm t:god", { include_multilingual: "true", unique: "prints" }),
	["lang:with-include_multilingual"],
);

// ── realistic user queries (the shape mtg-seeker issues) ──
const REALISTIC: [string, string, Record<string, string>][] = [
	["budget-modern-removal", "f:modern o:destroy t:instant usd<1", { order: "usd", dir: "asc" }],
	["commander-staples", "f:commander t:artifact o:draw cmc<=3", { order: "edhrec" }],
	["edh-ramp", "f:commander otag:ramp c:g cmc<=2", { order: "edhrec" }],
	["pauper-aggro", "f:pauper t:creature pow>=3 cmc<=2 r:common", { order: "cmc" }],
	["standard-bombs", "f:standard r:mythic t:creature cmc>=6", { order: "cmc", dir: "desc" }],
	["counterspells", "o:counter t:instant c:u f:legacy", { order: "name" }],
	["lands-that-fix", "t:land produces:wu -t:basic", { order: "released", dir: "desc" }],
	["dragon-tribal", "t:dragon c:r r:rare", { order: "power", dir: "desc" }],
	["cheap-planeswalkers", "t:planeswalker cmc<=3", { order: "cmc" }],
	["equipment", "t:equipment o:equip usd<5", { order: "usd" }],
	["snow-matters", "o:snow -t:land", { order: "name" }],
	["double-faced", "is:dfc c:u f:modern", { order: "name" }],
	["expensive-foils", "usd>=200 -is:promo", { order: "usd", dir: "desc" }],
	["art-search", 'a:"john avon" t:land', { order: "released" }],
	["flavor-hunt", 'ft:"jace" -t:planeswalker', { order: "released" }],
	["set-browse", "e:mh3", { order: "set", unique: "prints" }],
	["recent-legendaries", "t:legendary t:creature year>=2026", { order: "released", dir: "desc" }],
	["typeline-two-words", 't:"artifact creature" cmc<=2', { order: "name" }],
	["mana-symbol-hybrid", "m:{W/U} t:creature", { order: "cmc" }],
	["phyrexian-mana", "m:{U/P}", { order: "name" }],
	["x-spells", "m:{X}{R}{R} t:sorcery", { order: "cmc" }],
	["zero-results", "t:goblin t:island cmc:99", { order: "name" }],
	["single-result", '!"Black Lotus"', { order: "name" }],
	["big-page", "t:creature c:g cmc:3", { order: "name" }],
	["punctuated-name", 'name:"jace, the mind sculptor"', {}],
	["apostrophe-name", "name:sensei's", {}],
	["diacritic-name", "name:jötun", {}],
	["cjk-name-query", "name:アクスガルド", {}],
	["hyphenated", 'o:"draw a card" t:creature kw:flying cmc<=2', { order: "cmc" }],
	["unicode-quotes", "o:“draw”", {}],
];
for (const [name, q, params] of REALISTIC) add(`real-${name}`, "realistic", search(q, params), [`realistic:${name}`]);

// ── operators this port is not expected to implement, probed on purpose ──
const ADJACENT_OPERATORS: [string, string][] = [
	["oracleid", "oracleid:43fbfeec-bcaf-48b8-befe-b7346fec5a3a"],
	["game-paper", "game:paper e:khm t:god"],
	["in-arena", "in:arena e:khm t:god"],
	["st-core", "st:core t:god"],
	["cube-vintage", "cube:vintage t:god"],
	["new-art", "new:art e:khm"],
	["has-watermark", "has:watermark e:nph t:creature"],
	["stamp-oval", "stamp:oval e:khm"],
	["prefer-directive", "e:khm t:god prefer:oldest"],
	["direction-directive", "e:khm t:god direction:desc"],
	["sort-directive", "e:khm t:god sort:released"],
	["unique-directive", "e:khm t:god unique:prints"],
	["not-legal", "not:reprint e:khm t:god"],
	["date-set-code", "date>=khm t:god"],
	["cheapest-usd", "cheapest:usd e:khm t:god"],
];
for (const [name, q] of ADJACENT_OPERATORS)
	add(`adj-${name}`, "adjacent-operators", search(q), [`operator:${name}`], true);

// ── error and edge-case surface ──
const EDGE_CASES: [string, string][] = [
	["empty-q", "/cards/search?q="],
	["whitespace-q", "/cards/search?q=%20%20"],
	["missing-q", "/cards/search"],
	["page-zero", `${search("e:khm")}&page=0`],
	["page-negative", `${search("e:khm")}&page=-3`],
	["page-huge", `${search("e:khm")}&page=9999`],
	["page-nonnumeric", `${search("e:khm")}&page=abc`],
	["unbalanced-paren", search("e:khm (t:god")],
	["dangling-operator", search("t:")],
	["unknown-operator", search("nonsense:value")],
	["bad-comparison", search("cmc>=notanumber")],
	["bad-color", search("c:qq")],
	["bad-rarity", search("r:legendary")],
	["bad-format", search("f:notaformat")],
	["bad-set", search("e:zzzz")],
	["bad-lang", search("lang:zz e:khm")],
	["bad-regex", search("o:/[unclosed/")],
	["no-results", search("e:khm t:god cmc:99")],
	["pretty-flag", `${search("e:khm t:god")}&pretty=true`],
	["format-text", `${search("e:khm t:god")}&format=text`],
	["include-extras", `${search("e:khm")}&include_extras=true&unique=prints`],
	["include-variations", `${search("e:khm")}&include_variations=true&unique=prints`],
];
for (const [name, path] of EDGE_CASES) add(`edge-${name}`, "edge", path, [`edge:${name}`]);

// ── non-search routes worth a wide look ──
const OTHER_ROUTES: [string, string][] = [
	["random-shape", "/cards/random?q=e%3Akhm"],
	["autocomplete-lig", "/cards/autocomplete?q=lig"],
	["autocomplete-short", "/cards/autocomplete?q=a"],
	["autocomplete-cjk", "/cards/autocomplete?q=%E3%82%A2%E3%82%AF"],
	["named-exact", "/cards/named?exact=Lightning+Bolt"],
	["named-fuzzy-typo", "/cards/named?fuzzy=lightnig+bolt"],
	["named-ambiguous", "/cards/named?fuzzy=bolt"],
	["set-number", "/cards/khm/1"],
	["set-number-lang", "/cards/khm/1/ja"],
	["catalog-keywords", "/catalog/keyword-abilities"],
	["catalog-artists", "/catalog/artist-names"],
	["catalog-types", "/catalog/creature-types"],
	["symbology", "/symbology"],
	["sets", "/sets/khm"],
];
for (const [name, path] of OTHER_ROUTES) add(`route-${name}`, "routes", path, [`route:${name}`]);

// ─── the BLIND-SPOT backfill: combinations the per-column template cannot reach ──
//
// Everything above this line comes out of ONE template applied per column: `eq`, `neg`, `cmp`,
// `quoted`, `regex`. That shape has a property nobody wrote down and everybody relied on — a
// combination the template omits is omitted for EVERY column at once, so the sweep's 300-odd cases
// have the coverage of five shapes, not of 300. Five divergence families were found by hand while
// this file reported them green, and every one of them lives in a cell the template cannot emit:
//
//   1. NEGATED COMPARISON. `neg` is always negated EQUALITY (`-cmc:3`) and `cmp` is always a
//      POSITIVE comparison (`cmc>=3`). Nothing crosses them, so "every negated numeric comparison
//      is a silent tautology" was unobservable in 529 cases.
//   2. COLOUR BEYOND SINGLE-COLOUR `c:`. The colour probes are `c:rg`, `c:colorless`, `ci:wu` — the
//      one shape that already agreed under a union bitmask. `c=`, `c<=`, colour COUNTS, `c:c` and
//      multi-colour `c:` on a DFC-heavy corpus were absent, and the whole per-face colour gap sat
//      unobserved: NEW read 71 before the fix and 71 after.
//   3. A VACUOUS ANCHOR. All three `op-card_layout-*` probes anchor to `e:khm`, which has no
//      transform printing and no reversible printing at all. They read `ok` before the per-face
//      layout fix, after it, and throughout the period the data was wrong. `enumDomainCases` below
//      is the standing answer: every value the column can take gets a corpus-wide case, so no
//      anchor's gaps can hide a value.
//   4. A CONSTANT FIELD. `m:{2}{W}{W}` and `m>={3}{G}{G}{G}` are the only mana probes and both are
//      exact-symbol forms; the generic-mana reading (`m:{2}` at 151 under a cmc reading vs 102
//      under a pip reading) had no case at all.
//   5. NO FALSIFICATION MARGIN. A case whose expected value the WRONG model can also produce
//      cannot falsify it. `devotion:{r/g}` = 62 was reproduced exactly by a per-lane-OR model; only
//      `devotion:{r/g}{r/g}` = 16, which exceeds the 15 that OR of ({r}{r}=7, {g}{g}=8) can reach,
//      distinguishes them.
//
// These families are therefore added HERE, as explicit cases, and the reach analysis below is the
// standing guard that keeps their cells populated.

/** The anchor every negation row is measured against: `e:khm t:creature` = 151 on both sides. */
const NEG_ANCHOR = "e:khm t:creature";

// ── negated comparisons: the tautology set ──
//
// Scryfall drops the `-` on a comparison leaf outside the bitmask/enum columns, silently, and the
// term survives as a TAUTOLOGY rather than being removed (scratchpad/parity-sweep-findings.md §1,
// §4). Each of these must answer the anchor's own 151; a row that answers anything else is either
// side having changed its mind about the rule.
const NEG_TAUTOLOGY: [string, string][] = [
	["cmc-ge", "-cmc>=3"],
	["cmc-ne", "-cmc!=3"],
	["mv-ge", "-mv>=3"],
	["pow-ge", "-pow>=1"],
	["pow-gt", "-pow>1"],
	["tou-ne", "-tou!=1"],
	["pt-ge", "-pt>=3"],
	["loy-ge", "-loy>=3"],
	["usd-ge", "-usd>=1"],
	["eur-ge", "-eur>=1"],
	["year-ge", "-year>=2022"],
	["year-lt", "-year<2022"],
	["cn-ge", "-cn>=100"],
	["edhrec-ge", "-edhrec>=5000"],
	["paperprints-ge", "-paperprints>=2"],
	["cross-column", "-pow>=tou"],
	["nonnumeric-value", "-cmc>=notanumber"],
	["unknown-keyword", "-nonsense>=1"],
];
for (const [name, term] of NEG_TAUTOLOGY)
	add(`neg-taut-${name}`, "negation", search(`${term} ${NEG_ANCHOR}`), [`negation:tautology:${name}`]);
// The same leaf ALONE, where a tautology is the whole corpus and a removed term is a 400. This is
// the case that decides the implementation, and no anchored case can ask it.
for (const [name, term] of [
	["cmc", "-cmc>=3"],
	["pow", "-pow>=1"],
	["year", "-year!=2000"],
] as [string, string][])
	add(`neg-taut-alone-${name}`, "negation", search(term), [`negation:tautology-alone:${name}`]);
// A tautology in an `or` arm makes the GROUP match everything; a removed arm would leave the other
// arm's 13. The two mechanisms are indistinguishable on a bare leaf and separable here.
add("neg-taut-or-arm", "negation", search("(-pow>=1 or t:god) e:khm"), ["negation:tautology-or-arm"]);
add("neg-ignored-or-arm", "negation", search("(-pow:1 or t:god) e:khm"), ["negation:ignored-or-arm"]);

// ── negated comparisons: the HONORED set, which must NOT become tautologies ──
//
// The rule's boundary is the COLUMN, not the operator: the bitmask/enum columns negate correctly.
// A fix for the family above that is written as "drop the negation on comparisons" passes every
// tautology row and breaks every row here, so these are the half that pins the boundary.
const NEG_HONORED: [string, string][] = [
	["colors", "-c>=2"],
	["identity", "-id>=2"],
	["rarity", "-r>=rare"],
	["rarity-ne", "-r!=rare"],
	["mana", "-m>=2"],
	["produces", "-produces>=2"],
	["devotion", "-devotion>={r}{r}"],
	["collector-number-string", "-cn:100"],
];
for (const [name, term] of NEG_HONORED)
	add(`neg-honored-${name}`, "negation", search(`${term} ${NEG_ANCHOR}`), [`negation:honored:${name}`]);
// `devotion` with a non-symbol value is ignored-and-WARNED in both polarities — a value check, not
// a negation rule, and the one row that separates the two.
add("neg-devotion-nonsymbol", "negation", search(`-devotion>=2 ${NEG_ANCHOR}`), ["negation:devotion-value-check"]);

// ── the `date` asymmetry: one column, two names, two behaviours ──
//
// `-date<X` ≡ `date<X` — the `-` is DISCARDED and the term applied positively — while `-year<X` is
// the tautology of the family above. Same `released_at` column, opposite answers, and no case in
// the matrix ever spelled either.
const DATE_ASYMMETRY: [string, string][] = [
	["date-lt", "-date<2022"],
	["date-ge", "-date>=2022"],
	["date-gt", "-date>2021"],
	["date-ne", "-date!=2021"],
	["date-colon", "-date:2021"],
	["year-lt", "-year<2022"],
	["year-ne", "-year!=2021"],
];
for (const [name, term] of DATE_ASYMMETRY)
	add(`neg-date-${name}`, "negation", search(`${term} ${NEG_ANCHOR}`), [`negation:date-asymmetry:${name}`]);

// ── group negation: the same leaf inside `-( … )` ──
//
// `-` binds differently to a LEAF and to a GROUP, which is what makes the family above a binding
// bug rather than a negation bug. Every row here is the bare-leaf row's twin and must differ from
// it wherever the leaf form is a tautology.
const GROUP_NEGATION: [string, string][] = [
	["cmc", "-(cmc>=3)"],
	["cmc-or", "-(cmc>=3 or cmc>=3)"],
	["year", "-(year>=2022)"],
	["usd", "-(usd>=1)"],
	["date", "-(date>2021)"],
	["rarity", "-(r>=rare)"],
	["name", "-(name:a)"],
];
for (const [name, term] of GROUP_NEGATION)
	add(`neg-group-${name}`, "negation", search(`${term} ${NEG_ANCHOR}`), [`negation:group:${name}`]);

// ── colour, off the single-colour `c:` diagonal, on DFC-heavy corpora ──
//
// `e:mid` and `e:neo` are chosen for the same reason `e:khm` was wrong for layout: a modal DFC's
// two faces carry DIFFERENT colours, so a union bitmask and a per-face reading disagree there and
// nowhere else. `c=` (exact), `c<=` (subset), the COUNT forms and `c:c` are the operator shapes the
// template's `c:rg`/`c:colorless` pair never emits.
const COLOUR_CASES: [string, string][] = [
	["exact-two", "c=rg e:mid"],
	["exact-two-neo", "c=wu e:neo"],
	["exact-mono", "c=u e:mid t:creature"],
	["subset", "c<=wu e:mid t:creature"],
	["subset-neo", "c<=ur e:neo"],
	["count-ge", "c>=2 e:mid"],
	["count-eq", "c=2 e:mid"],
	["count-le", "c<=1 e:mid t:creature"],
	["colorless-c", "c:c e:mid"],
	["multicolour-colon", "c:rg e:mid"],
	["multicolour-m", "c:m e:mid"],
	["multi-neo", "c:ur e:neo t:creature"],
	["id-exact", "id=rg e:mid"],
	["id-count", "id>=3 e:mid"],
	["mdfc-front-back", "c:u e:mid layout:transform"],
	["mdfc-modal", "c:g e:znr layout:modal_dfc"],
	// Unscoped, so no anchor's colour gaps can hide the rule.
	["exact-five", "c=wubrg"],
	["colorless-creature", "c:c t:creature layout:modal_dfc"],
	["count-four", "c=4 t:creature"],
];
for (const [name, q] of COLOUR_CASES)
	add(`colour-${name}`, "colours", search(q, { order: "name" }), [`colour:${name}`]);

// ── generic-bearing mana ──
//
// The template's mana probes are `m:{R}{R}{R}`, `m:{2}{W}{W}` and `m>={3}{G}{G}{G}` — every one an
// exact-symbol form whose generic component is fixed. `m:{2}` is the discriminating shape: it reads
// 102 over `e:khm t:creature` as a counted PIP and 142 as a cmc, and nothing here asked.
const MANA_GENERIC: [string, string][] = [
	["generic-1", `m:{1} ${NEG_ANCHOR}`],
	["generic-2", `m:{2} ${NEG_ANCHOR}`],
	["generic-3", `m:{3} ${NEG_ANCHOR}`],
	["generic-ge", `m>=2 ${NEG_ANCHOR}`],
	["generic-cmp", `m>={2}{R} ${NEG_ANCHOR}`],
	// The falsification margin, corpus-wide because KHM has no creature costing exactly {R}{R}:
	// a {R}{R} cost has cmc 2 and generic 0, so a cmc reading answers `m={r}{r} m:{2}` = 24 and a
	// pip reading answers 0. No anchored case can produce a pair that far apart.
	["exact-rr", "m={r}{r} t:creature"],
	["exact-rr-generic", "m={r}{r} m:{2} t:creature"],
	["generic-zero", `m:{0} ${NEG_ANCHOR}`],
	["x-and-generic", "m:{X} m:{2} t:sorcery"],
];
for (const [name, q] of MANA_GENERIC) add(`mana-${name}`, "mana", search(q, { order: "name" }), [`mana:${name}`]);

// ── hybrid devotion, with a margin the wrong model cannot reach ──
//
// `devotion:{r/g}` = 62 is reproduced EXACTLY by a per-lane-OR model, which is why the unit tests
// written from that model all passed. `{r}{r}` = 7 and `{g}{g}` = 8 cannot OR to the 16 that
// `{r/g}{r/g}` answers, so the pair below is the falsifying case and the single-symbol row is only
// there to show it is not.
const DEVOTION_CASES: [string, string][] = [
	["mono-r", "devotion:{r}"],
	["mono-rr", "devotion:{r}{r}"],
	["mono-gg", "devotion:{g}{g}"],
	["hybrid-single", "devotion:{r/g}"],
	["hybrid-double", "devotion:{r/g}{r/g}"],
	["hybrid-ge", "devotion>={r/g}{r/g}"],
	["hybrid-wu", "devotion:{w/u}{w/u}"],
	["phyrexian", "devotion:{w/p}"],
	["anchored", `devotion:{r}{r} ${NEG_ANCHOR}`],
];
for (const [name, q] of DEVOTION_CASES)
	add(`devotion-${name}`, "devotion", search(q, { order: "name" }), [`devotion:${name}`]);

// ── `=` crossed with the text columns ──
//
// `=` appears in the matrix only through the numeric/enum columns. On a text column Scryfall
// collates `=` exactly as `:` does, and nothing here ever spelled it.
const EQ_TEXT: [string, string][] = [
	["name", "name=bolt"],
	["name-quoted", 'name="lightning bolt"'],
	["oracle", "o=flying e:khm"],
	["type", "t=creature e:khm"],
	["artist", 'a="rebecca guay"'],
	["artist-bare", "a=guay"],
	["flavor", "ft=the e:lea"],
	["keyword", "kw=flying e:khm"],
	["watermark", "wm=izzet t:instant"],
	["subtype", "subtype=eldrazi"],
	["layout", "layout=saga e:khm"],
	["set", "set=khm t:god"],
	["lang", "lang=ja e:khm t:god"],
];
for (const [name, q] of EQ_TEXT) add(`eq-text-${name}`, "eq-text", search(q, { order: "name" }), [`eq-text:${name}`]);

/**
 * Every value an enumerable column can take, and a corpus-wide case for each.
 *
 * THIS IS THE STANDING ANSWER TO A VACUOUS ANCHOR. An anchored probe can only ever see the values
 * its anchor happens to contain, and `e:khm` contains neither `transform` nor `reversible_card` —
 * which is the entire reason the per-face layout bug survived three green probes. A corpus-wide
 * case per value has no anchor to be wrong about, so a value that exists upstream and not here (or
 * the reverse) is a divergence rather than a silence.
 *
 * The lists are the DOMAIN, not a sample: a layout Scryfall adds and this table does not have shows
 * up in `enumDomainProblems` below as a value the sweep cannot see, rather than as nothing at all.
 */
const ENUM_DOMAINS: Record<string, string[]> = {
	layout: [
		"normal",
		"split",
		"flip",
		"transform",
		"modal_dfc",
		"meld",
		"leveler",
		"class",
		"case",
		"saga",
		"adventure",
		"mutate",
		"prototype",
		"battle",
		"planar",
		"scheme",
		"vanguard",
		"token",
		"double_faced_token",
		"emblem",
		"augment",
		"host",
		"art_series",
		"reversible_card",
	],
	border: ["black", "white", "silver", "gold", "borderless", "yellow"],
	frame: ["1993", "1997", "2003", "2015", "future"],
	rarity: ["common", "uncommon", "rare", "mythic", "special", "bonus"],
};
const enumDomainCases: string[] = [];
for (const [column, values] of Object.entries(ENUM_DOMAINS)) {
	for (const value of values) {
		enumDomainCases.push(`${column}:${value}`);
		// `unique=cards`, deliberately. The question here is whether the VALUE exists and selects the
		// same cards; `unique=prints` answers it while dragging in the `order=name` printing-tiebreak
		// family — one already-known divergence re-reported 26 more times, which buries the answer
		// rather than giving it.
		add(`domain-${column}-${value}`, "domains", search(`${column}:${value}`, { order: "name" }), [
			`domain:${column}:${value}`,
		]);
	}
}

// ─── THE REACH OF THE GENERATOR: what this matrix can and cannot emit ─────────
//
// A harness whose blind spots are undocumented reads as thorough while being structurally unable to
// observe what is wrong. This section is the standing statement of what the 400-odd cases above
// actually cover, computed FROM THE CASES rather than asserted about them, so it cannot drift.
//
// Every query leaf is scanned onto four axes, and the crossings are tallied:
//
//   OPERATOR    `:` `=` `!=` `>` `>=` `<` `<=`, plus a bare word and `!`-exact
//   POLARITY    positive, negated leaf (`-cmc>=3`), negated group (`-(cmc>=3)`)
//   VALUE FORM  bare word, quoted phrase, regex, mana symbols, number, date, colour letters,
//               another column's name (`pow>=tou`)
//   GROUPING    top level, inside parens, an `or` arm, inside a negated group
//
// OPERATOR × POLARITY is the crossing that hid the negated-comparison family for the whole life of
// this file: every `neg` probe was negated EQUALITY and every `cmp` probe was a POSITIVE
// comparison, so the `>=|negated-leaf` cell held zero cases out of 529 and the sweep read green
// through a family in which every single term was a silent tautology.
//
// `REQUIRED_CELLS` is the guard. A cell listed there and empty is a HARNESS finding, reported
// separately from the divergences so it can never be mistaken for one. `UNREACHABLE_CELLS` is the
// other half of the same statement: cells that are empty on purpose, each with the reason, so the
// difference between "not covered" and "not a thing" is written down rather than remembered.

type Polarity = "positive" | "negated-leaf" | "negated-group";
type Grouping = "top-level" | "paren" | "or-arm" | "in-negated-group";
type ValueForm = "word" | "quoted" | "regex" | "mana-symbols" | "number" | "date" | "colour-letters" | "column-ref";

interface Leaf {
	keyword: string;
	operator: string;
	value: string;
	polarity: Polarity;
	grouping: Grouping;
	valueForm: ValueForm;
}

/** Every alias of every column, so `pow>=tou` can be told from `pow>=2`. */
const ALL_ALIASES = new Set<string>((DB_COLUMNS as readonly FieldInfo[]).flatMap((c) => c.searchAliases));

/** The colour columns, whose values are letter sets rather than words. */
const COLOUR_KEYWORDS = new Set([
	"c",
	"color",
	"colors",
	"colour",
	"colours",
	"ci",
	"id",
	"identity",
	"commander",
	"coloridentity",
	"color_identity",
	"produces",
]);

const DATE_KEYWORDS = new Set(["date", "year", "released"]);

const CONNECTIVES = new Set(["or", "and"]);

const TERM_RE =
	/(-)?\(|\)|(-)?(!)?(?:([A-Za-z_][A-Za-z_0-9]*)(>=|<=|!=|>|<|=|:))?("[^"]*"|\/[^/]*\/|(?:\{[^}]*\})+|[^\s()]+)/g;

function classifyValue(keyword: string, value: string): ValueForm {
	if (value.startsWith('"')) return "quoted";
	if (value.startsWith("/")) return "regex";
	if (value.startsWith("{")) return "mana-symbols";
	if (DATE_KEYWORDS.has(keyword) && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(value)) return "date";
	if (/^-?\d+(\.\d+)?$/.test(value)) return "number";
	if (COLOUR_KEYWORDS.has(keyword) && /^[wubrgcm]+$/i.test(value)) return "colour-letters";
	if (keyword !== "" && ALL_ALIASES.has(value.toLowerCase())) return "column-ref";
	return "word";
}

/**
 * The leaves of one query string, each with its position on all four axes.
 *
 * Groups are tracked by id so an `or` found ANYWHERE in a group retroactively marks every leaf in
 * it as an `or` arm — `(t:god or t:giant or t:elf)` has its connectives after the first leaf, and a
 * single forward pass would file that leaf as a plain paren member.
 */
function scanLeaves(q: string): Leaf[] {
	const leaves: (Leaf & { groupId: number })[] = [];
	const stack: { id: number; negated: boolean }[] = [];
	const orGroups = new Set<number>();
	let nextGroupId = 1;
	TERM_RE.lastIndex = 0;
	for (let m = TERM_RE.exec(q); m !== null; m = TERM_RE.exec(q)) {
		const [text, openNeg, leafNeg, bang, keyword, operator, value] = m;
		if (text.endsWith("(") && value === undefined) {
			stack.push({ id: nextGroupId++, negated: openNeg === "-" });
			continue;
		}
		if (text === ")") {
			stack.pop();
			continue;
		}
		if (value === undefined) continue;
		const inGroup = stack[stack.length - 1];
		if (keyword === undefined && CONNECTIVES.has(value.toLowerCase())) {
			if (inGroup) orGroups.add(inGroup.id);
			continue;
		}
		const kw = (keyword ?? "").toLowerCase();
		const op = operator ?? (bang === "!" ? "!exact" : "bare");
		leaves.push({
			keyword: kw,
			operator: op,
			value,
			polarity: leafNeg === "-" ? "negated-leaf" : inGroup?.negated ? "negated-group" : "positive",
			grouping: inGroup ? (inGroup.negated ? "in-negated-group" : "paren") : "top-level",
			valueForm: classifyValue(kw, value),
			groupId: inGroup?.id ?? 0,
		});
	}
	for (const leaf of leaves) if (orGroups.has(leaf.groupId) && leaf.grouping === "paren") leaf.grouping = "or-arm";
	return leaves;
}

function queryOf(path: string): string | undefined {
	const qIndex = path.indexOf("?");
	if (qIndex < 0) return undefined;
	return new URLSearchParams(path.slice(qIndex + 1)).get("q") ?? undefined;
}

/** Every leaf of every query case, with the case it came from. */
const allLeaves: { caseName: string; leaf: Leaf }[] = [];
for (const c of cases) {
	const q = queryOf(c.path);
	if (q === undefined) continue;
	for (const leaf of scanLeaves(q)) allLeaves.push({ caseName: c.name, leaf });
}

function tally(key: (l: Leaf) => string): Map<string, number> {
	const out = new Map<string, number>();
	for (const { leaf } of allLeaves) out.set(key(leaf), (out.get(key(leaf)) ?? 0) + 1);
	return out;
}

const REACH_AXES: { name: string; key: (l: Leaf) => string }[] = [
	{ name: "operator × polarity", key: (l) => `${l.operator} × ${l.polarity}` },
	{ name: "value-form × operator", key: (l) => `${l.valueForm} × ${l.operator}` },
	{ name: "grouping × polarity", key: (l) => `${l.grouping} × ${l.polarity}` },
];
const reachGrid = REACH_AXES.map(({ name, key }) => ({ axis: name, cells: Object.fromEntries(tally(key)) }));

/**
 * Cells that MUST be populated, each with the divergence family it is the only way to see.
 *
 * Every entry here was written after a family escaped: the list is the accumulated evidence of what
 * this template omits by construction, not a wish list. An empty one is a harness defect.
 */
const REQUIRED_CELLS: { cell: string; why: string }[] = [
	{ cell: ">= × negated-leaf", why: "negated numeric comparison — the silent-tautology family" },
	{ cell: "> × negated-leaf", why: "the strict half of the same rule" },
	{ cell: "< × negated-leaf", why: "the reversed half, where `date` behaves differently again" },
	{ cell: "!= × negated-leaf", why: "`!=` negated, which the old comment claimed was honored and is not" },
	{ cell: ": × negated-leaf", why: "negated equality — the ignore-and-warn mechanism, a DIFFERENT one" },
	{ cell: ">= × negated-group", why: "`-(cmc>=3)`: the group form is honored where the leaf form is not" },
	{ cell: "in-negated-group × negated-group", why: "the binding difference between `-leaf` and `-( … )`" },
	{ cell: "or-arm × positive", why: "a term inside an `or` group, where a tautology shows as 323 not 13" },
	{ cell: "word × =", why: "`=` on a text column, where Scryfall collates it exactly as `:`" },
	{ cell: "colour-letters × =", why: "exact colour — `c:` and a union bitmask agree, `c=` does not" },
	{ cell: "colour-letters × <=", why: "colour subset" },
	{ cell: "number × >=", why: "colour/mana COUNT comparisons, distinct from the letter-set forms" },
	{ cell: "mana-symbols × :", why: "generic-bearing mana, where a cmc reading and a pip reading differ" },
	{ cell: "mana-symbols × >=", why: "mana containment with a generic component" },
	{ cell: "column-ref × >=", why: "cross-column comparison (`pow>=tou`)" },
	{ cell: "date × <", why: "the `date`/`year` split — one column, two names, two behaviours" },
	{ cell: "regex × :", why: "the `/…/` path on the text columns" },
	{ cell: "quoted × :", why: "phrase quoting" },
];

/**
 * Cells that are empty ON PURPOSE, with the reason. Asserted EMPTY, so a stale entry is a finding
 * too — the day one of these becomes a real query shape, the declaration says so.
 *
 * This half matters as much as the half above: without it, a reader of the grid cannot tell a gap
 * from an impossibility, and every future audit re-derives the same list from scratch.
 */
const UNREACHABLE_CELLS: { cell: string; why: string }[] = [
	{ cell: "regex × >=", why: "Scryfall has no ordering on a regex; `o>=/x/` is a parse error, not a query" },
	{ cell: "regex × <=", why: "same" },
	{ cell: "!exact × negated-leaf", why: '`-!"Name"` is not syntax upstream accepts' },
	{ cell: "!exact × negated-group", why: "same, one level out" },
	{ cell: "date × !exact", why: "`!` is a name-only operator, so it crosses with no typed value form" },
	{ cell: "colour-letters × !exact", why: "same" },
	{ cell: "mana-symbols × !exact", why: "same" },
	{ cell: "column-ref × !exact", why: "same" },
];

const reachProblems: string[] = [];
{
	const populated = new Set<string>();
	for (const { axis, cells } of reachGrid) {
		void axis;
		for (const [cell, n] of Object.entries(cells)) if (n > 0) populated.add(cell);
	}
	for (const { cell, why } of REQUIRED_CELLS)
		if (!populated.has(cell))
			reachProblems.push(`the matrix emits no leaf in the cell "${cell}" — ${why}. Nothing here can see it.`);
	for (const { cell } of UNREACHABLE_CELLS)
		if (populated.has(cell))
			reachProblems.push(`"${cell}" is declared UNREACHABLE but the matrix emits it — the declaration is stale.`);
}

/**
 * ANCHOR ADEQUACY: does each anchored probe's anchor contain rows exercising the feature?
 *
 * Any anchor set lacking a feature hides that feature for every probe that uses it. All three
 * `op-card_layout-*` probes anchor to `e:khm`, and KHM has no transform printing at all — so
 * `layout:transform e:khm` was 0 rows against 0 rows, and read `ok` before the per-face layout fix,
 * after it, and throughout the period the data was wrong. A comparison of two empty lists is not
 * evidence of anything, and until now nothing said so.
 *
 * The probes are derived from the CASES rather than declared, so a new anchored case is covered the
 * day it is written. Only the templated groups are scanned: a hand-written case that deliberately
 * asks for an empty result (`edge-no-results`) is not a template defect.
 */
interface AnchorProbe {
	/** Every templated case that leans on this (anchor, feature) pair. */
	caseNames: string[];
	anchor: string;
	feature: string;
	/**
	 * The feature appears NEGATED in at least one of those cases, which is a stricter requirement:
	 * an anchor where every row matches the feature is exactly as blind as one where none does. Both
	 * make `-feature` and `feature` compare a fixed list against a fixed list.
	 */
	negated: boolean;
}
/**
 * (anchor, feature) pairs that are inadequate ON PURPOSE, with the reason and where the question IS
 * asked properly.
 *
 * The same discipline as `UNREACHABLE_CELLS`: an exemption is a written claim that the vacuity is a
 * property of the SEARCH SEMANTICS rather than a badly chosen anchor, and a stale one — an
 * exemption whose probe has become adequate — is reported, so the list cannot quietly outlive its
 * reason.
 */
const ANCHOR_EXEMPTIONS: { anchor: string; feature: string; why: string }[] = [
	{
		anchor: "e:khm",
		feature: "lang:en",
		why:
			"a bare /cards/search returns one English row per card on BOTH sides, so no set anchor can " +
			"split on language — every row matches `lang:en` by construction. The multilingual group asks " +
			"the same question the only way it can be asked: `lang-negated` runs `-lang:en e:khm t:god` " +
			"with `unique=prints`, where the non-English printings exist to be removed.",
	},
];

const anchorProbes: AnchorProbe[] = [];
{
	const ANCHOR_KEYWORDS = new Set(["e", "s", "set", "edition"]);
	const byKey = new Map<string, AnchorProbe>();
	for (const c of cases) {
		if (c.group !== "operators" && c.group !== "aliases") continue;
		const q = queryOf(c.path);
		if (q === undefined) continue;
		const leaves = scanLeaves(q);
		const anchor = leaves.find((l) => ANCHOR_KEYWORDS.has(l.keyword) && l.polarity === "positive");
		if (!anchor) continue;
		const anchorTerm = `${anchor.keyword}${anchor.operator}${anchor.value}`;
		for (const leaf of leaves) {
			if (leaf === anchor || leaf.keyword === "") continue;
			// The POSITIVE spelling: a negated probe still needs its anchor to contain the thing it
			// is negating, or the negation is the only term doing any work.
			const feature = `${leaf.keyword}${leaf.operator}${leaf.value}`;
			const key = `${anchorTerm} ${feature}`;
			const existing = byKey.get(key);
			if (existing) {
				existing.caseNames.push(c.name);
				existing.negated ||= leaf.polarity !== "positive";
				continue;
			}
			const probe: AnchorProbe = {
				caseNames: [c.name],
				anchor: anchorTerm,
				feature,
				negated: leaf.polarity !== "positive",
			};
			byKey.set(key, probe);
			anchorProbes.push(probe);
		}
	}
}

// ─── the PERIPHERAL surface: response formats, reference routes, HTTP mechanics ──
//
// Everything above asks one question — is the RESULT SET right? — of a surface that was already
// swept exhaustively. This block asks the questions nothing was asking: what does a route serve in
// each `format`, what do the routes that describe Magic rather than return cards answer, and what
// does the wire look like around any of it (content type, cache tier, CORS, HEAD, an unknown route,
// a wrong method, a malformed URL).
//
// It runs through a DIFFERENT comparator (`runPeripheralCase`), because the oracle is different:
// the query families compare ordered id lists and card objects, and here the answer is often a CSV
// document, a 302's `Location`, a header, or an error body's exact bytes. Three groups, one runner:
//
//   formats     /cards/search, /cards/named, /cards/:id, /cards/:set/:number[/:lang], /cards/random
//               x {json, text, csv, image} x {version, face, pretty}, plus the empty result in each
//   reference   /sets, /sets/:code, /sets/:id, /sets/tcgplayer/:id, every /catalog/* Scryfall
//               publishes, /symbology, /symbology/parse-mana, and /cards/collection at its edges
//   http        content type, cache tier, CORS, HEAD, unknown route, wrong method, malformed URL
//
// THE MEASURED FORMAT TABLE, which is why the `formats` cases look asymmetric (api.scryfall.com,
// 2026-08-16, one request per cell):
//
//                       json    text    csv     image
//   /cards/search       yes     IGNORED yes     IGNORED
//   /cards/named        yes     yes     IGNORED yes
//   /cards/:id          yes     yes     IGNORED yes
//   /cards/:set/:num    yes     yes     IGNORED yes
//   /cards/random       yes     yes     IGNORED yes
//   collection, sets, catalog, symbology                 every format IGNORED
//
// "IGNORED" means the parameter is accepted and JSON comes back — never an error — and `format=CSV`
// is ignored too, so the match is case-sensitive. CSV pages exactly like JSON (175 rows, header row
// repeated per page, `422` past the end) and carries `has_more` in a response header because it has
// no envelope to put it in.

interface PeripheralCase {
	name: string;
	group: "formats" | "reference" | "http";
	path: string;
	method?: string;
	body?: string;
	covers: string[];
	/**
	 * A DOCUMENTED, deliberate divergence: what the README's deviations list says about it.
	 *
	 * Reported as LEDGERED rather than NEW. The string is the reason, not a label — a ledger entry
	 * that does not say why is indistinguishable from a bug someone got tired of.
	 */
	ledger?: string;
}

const peripheral: PeripheralCase[] = [];
const seenPeripheral = new Set<string>();

function addPeripheral(
	name: string,
	group: PeripheralCase["group"],
	path: string,
	covers: string[],
	extra: { method?: string; body?: string; ledger?: string } = {},
): void {
	const key = `${extra.method ?? "GET"} ${path} ${extra.body ?? ""}`;
	if (seenPeripheral.has(key)) return;
	seenPeripheral.add(key);
	peripheral.push({ name, group, path, covers, ...extra });
}

// ── formats ──

/** A frozen, small, multi-layout result: split cards, foreign rows, and every price shape. */
const FORMAT_SEARCH = "/cards/search?q=e%3Akhm+t%3Agod&order=name";
const FORMAT_CARD_ID = "77c6fa74-5543-42ac-9ead-0e890b188e99";
const NAMED = "/cards/named?exact=Lightning+Bolt";

/** Every route that takes a `format`, and what it does with each value. */
const FORMAT_ROUTES: [string, string, string][] = [
	["search", FORMAT_SEARCH, "&"],
	["named", NAMED, "&"],
	["id", `/cards/${FORMAT_CARD_ID}`, "?"],
	["setnum", "/cards/khm/1", "?"],
	["setnumlang", "/cards/khm/1/ja", "?"],
];
/**
 * `/cards/named` is the ONE route whose cache tier this port declines to copy: Scryfall sends 48
 * hours there and 16 everywhere else. See the README's deviations list and the block above
 * `CARDS_CACHE` in routes.ts — a card object embeds `prices` this deployment rebuilds nightly.
 */
const NAMED_TIER_LEDGER =
	"`/cards/named` keeps the 16-hour card tier where Scryfall sends 48. A card object embeds " +
	"`prices` and this store is rebuilt nightly, so no cached answer should outlive its data by more " +
	"than one import; `named` returns the same object every other route here does and had no reason " +
	"to be the one route with a different lifetime. Pre-existing and documented in the README.";

/**
 * `format=image` moves Scryfall's tier to 48 hours on EVERY route, including the ones where the
 * parameter is IGNORED and JSON comes back: `/cards/search?format=image` is `public, max-age=172800`
 * around a List. The tier follows the PARAMETER there rather than the payload. This port applies
 * the image tier where an image is actually served, which is the same rule stated in terms of what
 * is being cached — a List of card objects with prices in it does not become safe to hold for two
 * days because the caller spelled a format the route ignored.
 */
const SEARCH_IMAGE_TIER_LEDGER =
	"`format=image` flips Scryfall's tier to 48 hours even on `/cards/search`, where the parameter is " +
	"ignored and a List of card objects comes back. This port ties the image tier to serving an image.";

for (const [route, base, sep] of FORMAT_ROUTES) {
	const routeLedger = route === "named" ? NAMED_TIER_LEDGER : undefined;
	for (const format of ["json", "text", "csv", "image", "bogus", "CSV"]) {
		addPeripheral(
			`format-${route}-${format}`,
			"formats",
			`${base}${sep}format=${format}`,
			[`format:${route}:${format}`],
			{ ledger: routeLedger ?? (format === "image" && route === "search" ? SEARCH_IMAGE_TIER_LEDGER : undefined) },
		);
	}
	addPeripheral(`format-${route}-pretty`, "formats", `${base}${sep}pretty=true`, [`pretty:${route}`], {
		ledger: routeLedger,
	});
}
// `/cards/random` answers a different card every call, so only its STATUS, content type and tier
// say anything — which is exactly what this family compares, so it belongs here rather than being
// excluded the way `runCase` excludes it.
for (const format of ["json", "text", "csv", "image"])
	addPeripheral(`format-random-${format}`, "formats", `/cards/random?format=${format}`, [`format:random:${format}`]);

// image sub-parameters, including the two Scryfall falls back on rather than rejecting
for (const version of ["small", "normal", "large", "png", "art_crop", "border_crop", "bogus"])
	addPeripheral(
		`format-image-version-${version}`,
		"formats",
		`${NAMED}&format=image&version=${version}`,
		[`image:version:${version}`],
		{ ledger: NAMED_TIER_LEDGER },
	);
for (const face of ["front", "back", "sideways"])
	addPeripheral(`format-image-face-${face}`, "formats", `${NAMED}&format=image&face=${face}`, [`image:face:${face}`], {
		ledger: NAMED_TIER_LEDGER,
	});
// A two-image layout, where `back` is a different picture rather than the same one.
addPeripheral("format-image-dfc-back", "formats", "/cards/khm/1?format=image&face=back", ["image:face:dfc-back"]);

// CSV over paging, quoting, and every cell rule that has an edge
addPeripheral("csv-page1-of-many", "formats", "/cards/search?q=t%3Agoblin&order=name&format=csv", [
	"csv:has_more:true",
]);
addPeripheral("csv-page2", "formats", "/cards/search?q=t%3Agoblin&order=name&format=csv&page=2", ["csv:page-2"]);
addPeripheral("csv-page-past-end", "formats", "/cards/search?q=t%3Agoblin&order=name&format=csv&page=99", [
	"csv:beyond-end",
]);
addPeripheral("csv-empty-result", "formats", "/cards/search?q=e%3Akhm+t%3Agod+cmc%3A99&format=csv", ["csv:no-match"]);
addPeripheral("csv-quoted-comma", "formats", `${FORMAT_SEARCH}&format=csv`, ["csv:quoting:comma"]);
addPeripheral("csv-quoted-quote", "formats", "/cards/search?q=name%3Atoolbox&format=csv&unique=prints", [
	"csv:quoting:double-quote",
]);
addPeripheral("csv-empty-mana-cost", "formats", "/cards/search?q=e%3Akhm+t%3Aland&format=csv&order=name", [
	"csv:empty-string-vs-null",
]);
addPeripheral("csv-rarity-special", "formats", "/cards/search?q=r%3Aspecial&format=csv&order=name", [
	"csv:rarity:special",
]);
addPeripheral("csv-rarity-bonus", "formats", "/cards/search?q=r%3Abonus&format=csv&order=name", ["csv:rarity:bonus"]);
addPeripheral("csv-multiface", "formats", "/cards/search?q=%21%22Fire+%2F%2F+Ice%22&format=csv&unique=prints", [
	"csv:multiface",
]);
addPeripheral("csv-dfc", "formats", "/cards/search?q=%21%22Delver+of+Secrets%22&format=csv&unique=prints", [
	"csv:two-image-layout",
]);
addPeripheral("csv-foreign", "formats", "/cards/search?q=lang%3Aja+e%3Akhm+t%3Agod&format=csv&unique=prints", [
	"csv:foreign-row",
]);
addPeripheral("csv-unique-art", "formats", "/cards/search?q=e%3Akhm+t%3Agod&format=csv&unique=art&order=name", [
	"csv:unique-art",
]);
addPeripheral("csv-pretty-ignored", "formats", `${FORMAT_SEARCH}&format=csv&pretty=true`, ["csv:pretty-is-inert"]);
addPeripheral("csv-head", "formats", `${FORMAT_SEARCH}&format=csv`, ["csv:head"], { method: "HEAD" });
// The format families' error shapes: a miss, an ambiguity and a bad address, each asked in csv.
addPeripheral("format-named-miss-csv", "formats", "/cards/named?exact=Zzzzzz+Nope&format=csv", ["format:named:miss"], {
	ledger: NAMED_TIER_LEDGER,
});
addPeripheral(
	"format-named-ambiguous-csv",
	"formats",
	"/cards/named?fuzzy=bolt&format=csv",
	["format:named:ambiguous"],
	{
		ledger: NAMED_TIER_LEDGER,
	},
);
addPeripheral("format-id-miss-text", "formats", "/cards/00000000-0000-0000-0000-000000000001?format=text", [
	"format:id:miss",
]);
addPeripheral("format-setnum-miss-csv", "formats", "/cards/khm/99999?format=csv", ["format:setnum:miss"]);

// ── reference routes ──

addPeripheral("ref-sets-list", "reference", "/sets", ["sets:list"]);
addPeripheral("ref-sets-code", "reference", "/sets/khm", ["sets:code"]);
addPeripheral("ref-sets-code-upper", "reference", "/sets/KHM", ["sets:code:uppercase"]);
addPeripheral("ref-sets-id", "reference", "/sets/43057fad-b1c1-437f-bc48-0045bce6d8c9", ["sets:id"]);
addPeripheral("ref-sets-tcgplayer", "reference", "/sets/tcgplayer/2750", ["sets:tcgplayer"]);
addPeripheral("ref-sets-tcgplayer-miss", "reference", "/sets/tcgplayer/99999999", ["sets:tcgplayer:miss"]);
addPeripheral("ref-sets-tcgplayer-bare", "reference", "/sets/tcgplayer", ["sets:tcgplayer:no-id"]);
addPeripheral("ref-sets-miss", "reference", "/sets/zzzz", ["sets:miss"]);
addPeripheral("ref-sets-extra-segment", "reference", "/sets/khm/extra", ["sets:over-long-path"]);
addPeripheral("ref-sets-pretty", "reference", "/sets/khm?pretty=true", ["sets:pretty"]);
addPeripheral("ref-sets-format-csv", "reference", "/sets/khm?format=csv", ["sets:format-is-inert"]);

// EVERY catalog Scryfall publishes, enumerated from CATALOG_NAMES — which is the port's own list,
// so a name Scryfall adds shows up as a 404 here and a 200 there, and a name it drops the reverse.
// The candidates below are the other half of that question: plausible names probed on purpose, all
// of which 404 on both sides today (measured 2026-08-16), so an addition upstream is loud.
for (const name of CATALOG_NAMES)
	addPeripheral(`ref-catalog-${name}`, "reference", `/catalog/${name}`, [`catalog:${name}`]);
const CATALOG_CANDIDATES = [
	"subtypes",
	"dungeon-types",
	"plane-types",
	"phenomenon-types",
	"scheme-types",
	"vanguard-types",
	"conspiracy-types",
	"kindred-types",
	"sticker-types",
	"attraction-types",
	"card-layouts",
	"set-types",
	"languages",
	"rarities",
	"frame-effects",
	"promo-types",
	"finishes",
	"games",
	"border-colors",
	"security-stamps",
];
for (const name of CATALOG_CANDIDATES)
	addPeripheral(`ref-catalog-absent-${name}`, "reference", `/catalog/${name}`, [`catalog:absent:${name}`]);
addPeripheral("ref-catalog-unknown", "reference", "/catalog/not-a-catalog", ["catalog:unknown"]);
addPeripheral("ref-catalog-uppercase", "reference", "/catalog/Card-Types", ["catalog:case-sensitivity"]);
addPeripheral("ref-catalog-bare", "reference", "/catalog", ["catalog:no-name"]);
addPeripheral("ref-catalog-extra-segment", "reference", "/catalog/card-types/extra", ["catalog:over-long-path"]);
addPeripheral("ref-catalog-pretty", "reference", "/catalog/battle-types?pretty=true", ["catalog:pretty"]);

addPeripheral("ref-symbology", "reference", "/symbology", ["symbology:list"]);
addPeripheral("ref-symbology-pretty", "reference", "/symbology?pretty=true", ["symbology:pretty"]);
const MANA_COSTS = [
	["RUW", "RUW"],
	["braced", "%7B2%7D%7BW%7D%7BW%7D"],
	["empty", ""],
	["half", "%7BHW%7D"],
	["hybrid", "%7B2%2FW%7D"],
	["colorless-snow-x-y", "%7BC%7D%7BS%7D%7BX%7D%7BY%7D"],
	["bare-digits", "1WU"],
	["large-generic", "%7B100%7D"],
	["letters", "xyzzy"],
	["unparseable-braces", "%7BQQQ%7D"],
	["punctuation", "!!!"],
	["empty-braces", "%7B%7D"],
	["non-ascii", "%C3%A9"],
	["triple-hybrid", "%7BW%2FU%2FB%7D"],
];
for (const [name, cost] of MANA_COSTS)
	addPeripheral(`ref-parse-mana-${name}`, "reference", `/symbology/parse-mana?cost=${cost}`, [`parse-mana:${name}`]);
addPeripheral("ref-parse-mana-missing", "reference", "/symbology/parse-mana", ["parse-mana:no-parameter"]);
addPeripheral("ref-parse-mana-pretty", "reference", "/symbology/parse-mana?cost=RUW&pretty=true", [
	"parse-mana:pretty",
]);
addPeripheral(
	"ref-parse-mana-extra-segment",
	"reference",
	"/symbology/parse-mana/extra?cost=RUW",
	["parse-mana:over-long-path"],
	{
		ledger:
			"the dispatch 404 BODY is upstream's routes listing (`{title, description: {routes}}`) rather " +
			"than Scryfall's error object; status, content type and tier all match. Same entry as " +
			"http-unknown-route.",
	},
);

// ── /cards/collection at its edges ──

const BOLT_ID = "77c6fa74-5543-42ac-9ead-0e890b188e99";
const collectionBody = (identifiers: unknown[]): string => JSON.stringify({ identifiers });
const addCollection = (name: string, covers: string[], identifiers: unknown[], path = "/cards/collection"): void =>
	addPeripheral(`coll-${name}`, "reference", path, covers, { method: "POST", body: collectionBody(identifiers) });

// every identifier kind, one at a time — including the two that LOOK like identifiers and are not
addCollection("id", ["collection:id"], [{ id: BOLT_ID }]);
addCollection("mtgo_id", ["collection:mtgo_id"], [{ mtgo_id: 54957 }]);
addCollection("multiverse_id", ["collection:multiverse_id"], [{ multiverse_id: 409574 }]);
addCollection("oracle_id", ["collection:oracle_id"], [{ oracle_id: "4457ed35-7c10-48c8-9776-456485fdf070" }]);
addCollection(
	"illustration_id",
	["collection:illustration_id"],
	[{ illustration_id: "82c60c8b-9573-4b62-9d76-42d84fb63d1d" }],
);
addCollection("name", ["collection:name"], [{ name: "Lightning Bolt" }]);
addCollection("name-set", ["collection:name+set"], [{ name: "Lightning Bolt", set: "clu" }]);
addCollection("set-cn", ["collection:set+collector_number"], [{ set: "khm", collector_number: "1" }]);
addCollection("set-cn-reversed", ["collection:key-order"], [{ collector_number: "1", set: "khm" }]);
addCollection("arena_id", ["collection:arena_id-is-not-an-identifier"], [{ arena_id: 67330 }]);
addCollection("set-only", ["collection:schema:set"], [{ set: "khm" }]);
addCollection("cn-only", ["collection:schema:collector_number"], [{ collector_number: "1" }]);
addCollection("set-lang", ["collection:schema:set+lang"], [{ set: "khm", lang: "ja" }]);
addCollection("empty-object", ["collection:schema:empty"], [{}]);
addCollection("unknown-key", ["collection:schema:unrecognized"], [{ nonsense: "x" }]);
addCollection("name-plus-unknown-key", ["collection:extra-keys-ignored"], [{ name: "Lightning Bolt", zzz: 1 }]);
// `lang` is accepted and IGNORED — this one must come back ENGLISH on both sides.
addCollection("set-cn-lang", ["collection:lang-is-ignored"], [{ set: "khm", collector_number: "40", lang: "ja" }]);
addCollection("bad-uuid", ["collection:uuid-validation"], [{ id: "not-a-uuid" }]);
addCollection("unknown-uuid", ["collection:unknown-v4-is-not_found"], [{ id: "00000000-0000-4000-8000-000000000000" }]);
addCollection("non-integer-mtgo", ["collection:integer-validation"], [{ mtgo_id: "abc" }]);
addCollection("non-integer-multiverse", ["collection:integer-validation"], [{ multiverse_id: "abc" }]);
addCollection("no-fuzzy", ["collection:names-are-exact"], [{ name: "lightnig bolt" }]);
addCollection("null-entry", ["collection:non-object-entry"], [null]);
addCollection("string-entry", ["collection:non-object-entry"], ["Lightning Bolt"]);
addCollection("empty-list", ["collection:count:0"], []);
addCollection(
	"75",
	["collection:count:75"],
	Array.from({ length: 75 }, () => ({ name: "Lightning Bolt" })),
);
addCollection(
	"76",
	["collection:count:76"],
	Array.from({ length: 76 }, () => ({ name: "Lightning Bolt" })),
);
addCollection(
	"duplicates",
	["collection:duplicates-are-repeated"],
	[{ id: BOLT_ID }, { id: BOLT_ID }, { id: BOLT_ID }],
);
addCollection(
	"mixed-found-and-not",
	["collection:not_found-ordering"],
	[{ name: "Black Lotus" }, { name: "Nope Alpha" }, { name: "Island" }, { name: "Nope Beta" }, { name: "Mox Pearl" }],
);
addCollection("pretty", ["collection:pretty"], [{ name: "Lightning Bolt" }], "/cards/collection?pretty=true");
addCollection(
	"format-csv",
	["collection:format-is-inert"],
	[{ name: "Lightning Bolt" }],
	"/cards/collection?format=csv",
);
addPeripheral("coll-identifiers-not-array", "reference", "/cards/collection", ["collection:not-an-array"], {
	method: "POST",
	body: JSON.stringify({ identifiers: {} }),
});
addPeripheral("coll-no-identifiers-key", "reference", "/cards/collection", ["collection:absent-list"], {
	method: "POST",
	body: JSON.stringify({}),
});

// ── HTTP mechanics ──

addPeripheral("http-head-search", "http", FORMAT_SEARCH, ["head:search"], { method: "HEAD" });
addPeripheral("http-head-card", "http", `/cards/${FORMAT_CARD_ID}`, ["head:card"], { method: "HEAD" });
addPeripheral("http-head-sets", "http", "/sets", ["head:sets"], { method: "HEAD" });
addPeripheral("http-head-catalog", "http", "/catalog/battle-types", ["head:catalog"], { method: "HEAD" });
addPeripheral("http-head-parse-mana", "http", "/symbology/parse-mana?cost=RUW", ["head:parse-mana"], {
	method: "HEAD",
});
addPeripheral("http-head-unknown", "http", "/nonexistent-route", ["head:404"], { method: "HEAD" });
addPeripheral("http-head-search-no-q", "http", "/cards/search", ["head:400"], { method: "HEAD" });
addPeripheral("http-options-search", "http", FORMAT_SEARCH, ["cors:preflight:search"], { method: "OPTIONS" });
addPeripheral("http-options-collection", "http", "/cards/collection", ["cors:preflight:collection"], {
	method: "OPTIONS",
});
addPeripheral("http-options-catalog", "http", "/catalog/battle-types", ["cors:preflight:catalog"], {
	method: "OPTIONS",
});
addPeripheral("http-unknown-route", "http", "/nonexistent-route", ["404:unknown-route"]);
addPeripheral("http-unknown-nested", "http", "/foo/bar/baz", ["404:unknown-nested"]);
addPeripheral("http-post-to-get-route", "http", FORMAT_SEARCH, ["method:post-to-get"], { method: "POST", body: "{}" });
addPeripheral("http-get-collection", "http", "/cards/collection", ["method:get-to-post"], {
	ledger:
		"the STATUS, body and absent `Allow` all match; only the tier differs (`max-age=57600` there, " +
		"`no-cache` here). It differs for a routing reason rather than a policy one: api.scryfall.com " +
		"has no `/cards/collection` GET route, so `collection` falls through its `/cards/:id` pattern " +
		"and earns that route's not-a-uuid tier. Here `cards/collection` is its own route key, so the " +
		"same request is a method mismatch. Every OTHER wrong-method 404 measured — on /cards/search, " +
		"/cards/named, /cards/:id and /sets — is `no-cache` on both sides.",
});
addPeripheral("http-delete-card", "http", `/cards/${FORMAT_CARD_ID}`, ["method:delete"], { method: "DELETE" });
addPeripheral("http-put-sets", "http", "/sets", ["method:put"], { method: "PUT", body: "{}" });
addPeripheral("http-root", "http", "/", ["route:root"], {
	ledger:
		"Scryfall's API root is a 400 saying no data lives there; this origin's root is the project's " +
		"own web interface, which is the whole reason the deployment exists beside the API.",
});
addPeripheral("http-cards-bare", "http", "/cards", ["route:cards-listing"], {
	ledger:
		"`/cards` is an UPSTREAM route this port serves (a paginated all-cards List); api.scryfall.com " +
		"404s it. Serving a route Scryfall does not have cannot break a client that only calls Scryfall's.",
});
addPeripheral("http-cards-bare-page", "http", "/cards?page=2", ["route:cards-listing:paged"], {
	ledger: "same as http-cards-bare.",
});
addPeripheral("http-trailing-slash-search", "http", "/cards/search/?q=e%3Akhm+t%3Agod", ["path:trailing-slash"]);
addPeripheral("http-double-slash", "http", "//cards/search?q=e%3Akhm+t%3Agod", ["path:double-slash"]);
addPeripheral("http-sets-trailing-slash", "http", "/sets/", ["path:trailing-slash:sets"]);
addPeripheral("http-malformed-percent", "http", "/cards/%zz", ["path:malformed-escape"], {
	ledger:
		"api.scryfall.com never sees this: Cloudflare's edge rejects the malformed escape with its own " +
		"400 HTML page before the origin runs. In dev this Worker receives the path and answers its own " +
		"404; in production the same edge sits in front of this deployment, so the observable behaviour " +
		"converges. Nothing here is implementable at the origin.",
});
addPeripheral("http-bad-utf8-query", "http", "/cards/search?q=%E0%A4%A", ["query:malformed-escape"], {
	ledger: "same edge-vs-origin split as http-malformed-percent; the STATUS matches, the body is the edge's HTML.",
});

// ─── pagination + ordering depth ─────────────────────────────────────────────
//
// The part the two-phase gather most needs proving. Phase 1 asks every partition for its best
// `offset + limit` keys FROM ZERO and merges bytewise (gather.ts:248); the caller's offset is
// applied ONCE to the merged order. A page therefore proves more the deeper it sits: page 1 is the
// one page where an offset bug is invisible.
//
// Hash partitioning means "a page that lands exactly on a partition boundary" is not constructible
// — partitions are hash(oracle_id) % N, so consecutive rows of any ordering come from arbitrary
// partitions and every page straddles all of them. The analogous stressors, all included below:
// exact multiples of PAGE_SIZE, a page whose window opens one row after a page boundary, and deep
// offsets far past any per-partition prefix.

interface PageWalk {
	name: string;
	q: string;
	params: Record<string, string>;
	/** Pages to visit beyond 1, 2, middle and last. */
	extra?: number[];
}

const PAGE_WALKS: PageWalk[] = [
	{ name: "khm-prints-set", q: "e:khm", params: { unique: "prints", order: "set" }, extra: [3] },
	{ name: "khm-prints-name", q: "e:khm", params: { unique: "prints", order: "name" } },
	{ name: "khm-prints-released-desc", q: "e:khm", params: { unique: "prints", order: "released", dir: "desc" } },
	{ name: "goblins-name", q: "t:goblin", params: { order: "name" }, extra: [4] },
	{ name: "artist-guay-released", q: 'a:"rebecca guay"', params: { unique: "prints", order: "released" } },
	{ name: "lea-prints-cn", q: "e:lea", params: { unique: "prints", order: "set" } },
	{ name: "big-cmc3-name", q: "t:creature cmc:3 c:g", params: { order: "name" }, extra: [2, 5] },
	{ name: "deep-usd-desc", q: "t:creature", params: { order: "usd", dir: "desc" }, extra: [10, 37] },
];

// ─── comparison ───────────────────────────────────────────────────────────────

type Classification =
	| "KNOWN"
	| "IN-FLIGHT"
	| "CORPUS-POLICY"
	| "VINTAGE"
	| "UNSUPPORTED"
	| "LEDGERED"
	| "INCONCLUSIVE"
	/**
	 * A defect in THIS HARNESS, not in the port: a cell the generator cannot emit, or a probe whose
	 * anchor cannot exercise the feature it claims to test.
	 *
	 * Its own classification on purpose. Filed as NEW it would inflate the divergence count and be
	 * read as a regression; filed as a log line it would be scrolled past. It is neither — it is the
	 * sweep reporting the boundary of what it is able to observe, which is the one thing a green run
	 * cannot otherwise tell you.
	 */
	| "BLIND-SPOT"
	| "NEW";

/**
 * The deliberate import filters, as `passes_filters` in engine/builder/src/transform.rs applies
 * them (a port of upstream card_processing.py's `preprocess_card`, lines 104-125).
 *
 * A card api.scryfall.com returns and this mirror does not is FAR more often one of these than a
 * bug: the corpus is smaller than Scryfall's on purpose. Every Scryfall row is right there in the
 * response being compared, so the rule can be evaluated for free — which is what separates
 * "deliberate corpus policy" from "the store is missing a card it should have".
 */
function importPolicyExclusion(card: Json | undefined): string | undefined {
	if (!isObject(card)) return undefined;
	const legalities = card.legalities;
	if (isObject(legalities) && !Object.values(legalities).some((v) => v === "legal" || v === "restricted"))
		return "never-legal (no legal/restricted status in any format)";
	const promoTypes = card.promo_types;
	if (Array.isArray(promoTypes) && promoTypes.includes("playtest")) return "playtest promo";
	// NOT a clause any more: upstream drops a printing whose `games` omits "paper", and this port
	// stopped, because Scryfall serves every one of those from a bare `/cards/search` with default
	// parameters (`q=!"A-Tyvar Kell"` -> 200 khm/A-198, `is:rebalanced` -> 216, measured
	// 2026-08-16). 9,119 printings, and a miss on one of them is a BUG here, not policy — which is
	// what leaving it out of this function says.
	const setType = card.set_type;
	if (setType === "funny") return "funny set (un-sets and joke products)";
	if (setType === "memorabilia") return "memorabilia set (world championship / oversized / 30th)";
	const typeLine = card.type_line;
	if (typeof typeLine === "string" && /(^|\s)(Card|Token)($|\s|—)/.test(typeLine.split("//")[0] ?? typeLine))
		return "unplayable Card/Token type line";
	return undefined;
}

interface Finding {
	classification: Classification;
	label: string;
	kind: string;
	detail: string;
	caseName: string;
	path: string;
}

const findings: Finding[] = [];
/** Objects compared byte-exactly, and the aggregate of every path that differed. */
const objectPathStats = new Map<
	string,
	{ count: number; classification: Classification; label: string; example: string }
>();
let objectsCompared = 0;
let pagesCompared = 0;

/** The volatile-value STRUCTURE guard, accumulated over every body this run touches. */
const shapeTally = newVolatileShapeTally();

function record(f: Finding): void {
	findings.push(f);
}

function parse(body: string): Json | undefined {
	try {
		return JSON.parse(body) as Json;
	} catch {
		return undefined;
	}
}

function idsOf(body: Json | undefined): string[] {
	if (!body || !isObject(body)) return [];
	const data = body.data;
	if (!Array.isArray(data)) return [];
	return data.map((row) => (isObject(row) && typeof row.id === "string" ? row.id : "?"));
}

/** One row of a list page, reduced to what the list-level comparison asks about. */
interface Row {
	id: string;
	oracleId: string;
	name: string;
	set: string;
	cn: string;
	lang: string;
	card: Json;
}

function rowsOf(body: Json | undefined): Row[] {
	if (!body || !isObject(body)) return [];
	const data = body.data;
	if (!Array.isArray(data)) return [];
	return data.filter(isObject).map((row) => ({
		id: typeof row.id === "string" ? row.id : "?",
		oracleId: typeof row.oracle_id === "string" ? row.oracle_id : "?",
		name: typeof row.name === "string" ? row.name : "?",
		set: typeof row.set === "string" ? row.set : "?",
		cn: typeof row.collector_number === "string" ? row.collector_number : "?",
		lang: typeof row.lang === "string" ? row.lang : "?",
		card: row,
	}));
}

/**
 * The value the requested ordering actually sorts on, as the card object carries it.
 *
 * This is what turns "the two sides disagree about row 47" into a root cause: if the two rows carry
 * the SAME sort value, the sides disagree about the TIEBREAK (plan A4's opaque key suffix —
 * edhrec_rank, oracle_id, prefer, illustration_id, scryfall_id — against whatever Scryfall does);
 * if they carry different values, the primary sort itself is wrong, which is a far worse bug.
 */
function sortValue(row: Row | undefined, order: string): string {
	if (!row || !isObject(row.card)) return "?";
	const c = row.card;
	const price = (kind: string): string =>
		isObject(c.prices) && typeof c.prices[kind] === "string" ? (c.prices[kind] as string) : "null";
	switch (order) {
		case "name":
			return String(c.name);
		case "cmc":
			return String(c.cmc);
		case "released":
			return `${String(c.released_at)}`;
		case "set":
			return `${String(c.set)}/${String(c.collector_number)}`;
		case "rarity":
			return String(c.rarity);
		case "artist":
			return String(c.artist);
		case "color":
			return stringifyScryfall((c.colors ?? null) as Json);
		case "usd":
			return price("usd");
		case "eur":
			return price("eur");
		case "tix":
			return price("tix");
		case "power":
			return String(c.power);
		case "toughness":
			return String(c.toughness);
		case "edhrec":
			return String(c.edhrec_rank);
		default:
			return "n/a";
	}
}

/**
 * Orderings whose sort column is one of the values this harness strips as VOLATILE everywhere else.
 *
 * A price or an edhrec rank moves daily; the local store carries yesterday's bulk dump and
 * api.scryfall.com carries today's, so `order=usd` puts the same two cards in a different sequence
 * on the two sides without anything being wrong. Divergences under these orderings are recorded as
 * VINTAGE — the sort itself is unfalsifiable here, and proving it needs a store built from the same
 * snapshot the API is serving.
 */
const VOLATILE_ORDERINGS = new Set(["usd", "eur", "tix", "edhrec"]);

function orderParamOf(path: string): string {
	const m = /[?&]order=([^&]+)/.exec(path);
	return m?.[1] ? decodeURIComponent(m[1]) : "name";
}

function describe(row: Row | undefined): string {
	return row
		? `${row.name} (${row.set}/${row.cn}${row.lang === "en" ? "" : ` ${row.lang}`}, ${row.id.slice(0, 8)})`
		: "(none)";
}

/** Ids the store simply does not have, as far as our own /cards/:id can tell. */
const absentFromStore = new Map<string, boolean>();

async function isAbsentFromStore(id: string): Promise<boolean> {
	const cached = absentFromStore.get(id);
	if (cached !== undefined) return cached;
	const res = await fetchOurs(`/cards/${id}`);
	const absent = res.status === 404;
	absentFromStore.set(id, absent);
	return absent;
}

interface OrderAnalysis {
	commonCount: number;
	sameOrder: boolean;
	firstDivergenceIndex: number;
	oursSeq: string[];
	theirsSeq: string[];
}

/**
 * The sorting oracle: do the ids BOTH sides returned appear in the same relative order?
 *
 * Restricting to the intersection is what makes this vintage-proof — a card the live API has and
 * the local dump does not simply drops out of both sequences instead of shifting one of them.
 */
function analyzeOrder(ours: string[], theirs: string[]): OrderAnalysis {
	const common = new Set(ours.filter((id) => theirs.includes(id)));
	const a = ours.filter((id) => common.has(id));
	const b = theirs.filter((id) => common.has(id));
	let firstDivergenceIndex = -1;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] !== b[i]) {
			firstDivergenceIndex = i;
			break;
		}
	}
	return {
		commonCount: common.size,
		sameOrder: firstDivergenceIndex === -1,
		firstDivergenceIndex,
		oursSeq: a,
		theirsSeq: b,
	};
}

/** Compare the two `next_page` URLs modulo origin: pathname plus sorted query parameters. */
function nextPageShape(url: unknown): string | undefined {
	if (typeof url !== "string") return undefined;
	try {
		const u = new URL(url);
		const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
		return `${u.pathname}?${params.map(([k, v]) => `${k}=${v}`).join("&")}`;
	} catch {
		return url;
	}
}

/** Byte-exact card-object comparison, live-parity's pipeline, on a sample of a page. */
function compareObjects(c: SweepCase, oursBody: Json, theirsBody: Json): void {
	if (!runObjects || !isObject(oursBody) || !isObject(theirsBody)) return;
	const oursData = oursBody.data;
	const theirsData = theirsBody.data;
	if (!Array.isArray(oursData) || !Array.isArray(theirsData)) return;
	for (let i = 0; i < Math.min(OBJECT_SAMPLE, oursData.length, theirsData.length); i++) {
		const oursCard = oursData[i] as Json;
		const theirsCard = theirsData[i] as Json;
		if (!isObject(oursCard) || !isObject(theirsCard) || oursCard.id !== theirsCard.id) continue;
		objectsCompared++;
		const oursReduced = stripPatternKeys(stripVolatileSpecials(substituteOrigin(oursCard)), volatilePatterns);
		const theirsReduced = stripAffiliateDecoration(
			stripPatternKeys(stripPatternKeys(stripVolatileSpecials(theirsCard), volatilePatterns), ledgerPatterns),
		);
		if (canonical(oursReduced) === canonical(theirsReduced)) continue;
		const diffs: Diff[] = [];
		collectDiffs(theirsReduced, oursReduced, [], diffs);
		for (const diff of diffs) {
			// Array indices collapse to `*` so `all_parts.3.name` and `all_parts.0.name` aggregate.
			const key = diff.path.map((s) => (/^\d+$/.test(s) ? "*" : s)).join(".");
			const known = knownDeviationFor(diff.path);
			const flight = known ? undefined : inFlightForPath(diff.path);
			const classification: Classification = known ? "KNOWN" : flight ? "IN-FLIGHT" : "NEW";
			const label = known?.name ?? flight?.name ?? `${diff.kind}`;
			const stat = objectPathStats.get(key);
			const example = `${c.name} card ${String(oursCard.id)} (${String(oursCard.name)}): scryfall ${excerpt(diff.scryfall)} / ours ${excerpt(diff.ours)}`;
			if (stat) stat.count++;
			else objectPathStats.set(key, { count: 1, classification, label, example });
		}
	}
}

async function runCase(c: SweepCase): Promise<void> {
	const ours = await fetchOurs(c.path);
	const theirs = await fetchScryfall(c.path);
	const oursBody = parse(ours.body);
	const theirsBody = parse(theirs.body);
	const flight = inFlightForCase(c);
	const baseClass: Classification = c.unsupported ? "UNSUPPORTED" : flight ? "IN-FLIGHT" : "NEW";
	const baseLabel = c.unsupported ? "unsupported-operator" : (flight?.name ?? "");

	// 1. status
	if (ours.status !== theirs.status) {
		const oursCode = isObject(oursBody) ? String(oursBody.code ?? "") : "";
		const theirsCode = isObject(theirsBody) ? String(theirsBody.code ?? "") : "";
		// "We 404 where Scryfall answers" is the corpus talking whenever every row Scryfall found is
		// one the import filters drop on purpose — silver-border goblins are the archetype.
		const theirsPolicy = new Map<string, number>();
		let theirsUnexplained = 0;
		for (const row of rowsOf(theirsBody)) {
			const reason = importPolicyExclusion(row.card);
			if (reason) theirsPolicy.set(reason, (theirsPolicy.get(reason) ?? 0) + 1);
			else theirsUnexplained++;
		}
		const allPolicy = ours.status === 404 && theirs.status === 200 && theirsPolicy.size > 0 && theirsUnexplained === 0;
		record({
			classification: allPolicy ? "CORPUS-POLICY" : baseClass,
			label: baseLabel || "status",
			kind: "status",
			detail:
				`scryfall ${theirs.status} (${theirsCode}) vs ours ${ours.status} (${oursCode}); scryfall details=${
					isObject(theirsBody) ? excerpt(theirsBody.details ?? null) : "?"
				}; ours details=${isObject(oursBody) ? excerpt(oursBody.details ?? null) : "?"}` +
				`${theirsPolicy.size > 0 ? `; scryfall's rows: ${[...theirsPolicy].map(([r, n]) => `${n}x ${r}`).join("; ")}${theirsUnexplained > 0 ? `, ${theirsUnexplained} not policy-excluded` : ""}` : ""}`,
			caseName: c.name,
			path: c.path,
		});
		return;
	}
	if (!oursBody || !theirsBody) return;
	if (!isObject(oursBody) || !isObject(theirsBody)) return;

	// The shape of what the volatile reduction is about to erase. Card-independent presence and
	// format checks, so they hold even on /cards/random, where the two sides answer different cards.
	for (const problem of checkVolatileShape(oursBody, theirsBody, shapeTally))
		record({
			classification: "NEW",
			label: "volatile-shape",
			kind: "volatile-shape",
			detail: problem,
			caseName: c.name,
			path: c.path,
		});

	// /cards/random answers a DIFFERENT card on each call by definition, so neither its object nor
	// its id says anything about parity; only its status and shape would, and those are covered.
	if (c.path.startsWith("/cards/random")) return;

	// Non-list routes: compare the whole reduced object.
	if (oursBody.object !== "list" || theirsBody.object !== "list") {
		compareObjects(c, { data: [oursBody] } as Json, { data: [theirsBody] } as Json);
		const oursReduced = stripPatternKeys(stripVolatileSpecials(substituteOrigin(oursBody)), volatilePatterns);
		const theirsReduced = stripAffiliateDecoration(
			stripPatternKeys(stripPatternKeys(stripVolatileSpecials(theirsBody), volatilePatterns), ledgerPatterns),
		);
		if (canonical(oursReduced) !== canonical(theirsReduced)) {
			const diffs: Diff[] = [];
			collectDiffs(theirsReduced, oursReduced, [], diffs);
			for (const diff of diffs.slice(0, 6)) {
				const known = knownDeviationFor(diff.path);
				const pathFlight = known ? undefined : inFlightForPath(diff.path);
				record({
					classification: known ? "KNOWN" : (pathFlight ?? flight) ? "IN-FLIGHT" : baseClass,
					label: known?.name ?? pathFlight?.name ?? (baseLabel || "object"),
					kind: "object",
					detail: `${diff.path.join(".") || "(root)"}: scryfall ${excerpt(diff.scryfall)} / ours ${excerpt(diff.ours)}`,
					caseName: c.name,
					path: c.path,
				});
			}
		}
		return;
	}

	// 2. total_cards / has_more
	const oursTotal = typeof oursBody.total_cards === "number" ? oursBody.total_cards : undefined;
	const theirsTotal = typeof theirsBody.total_cards === "number" ? theirsBody.total_cards : undefined;
	const oursRows = rowsOf(oursBody);
	const theirsRows = rowsOf(theirsBody);
	const oursIds = oursRows.map((r) => r.id);
	const theirsIds = theirsRows.map((r) => r.id);
	const oursById = new Map(oursRows.map((r) => [r.id, r]));
	const theirsById = new Map(theirsRows.map((r) => [r.id, r]));
	const onlyTheirs = theirsRows.filter((r) => !oursById.has(r.id));
	const onlyOurs = oursRows.filter((r) => !theirsById.has(r.id));

	// Why is a row Scryfall returned missing here? Three different answers, and only one of them
	// is a finding: the deliberate import filters, a store built from an older dump, or a gap.
	const policyReasons = new Map<string, number>();
	const unexplained: Row[] = [];
	for (const row of onlyTheirs) {
		const reason = importPolicyExclusion(row.card);
		if (reason) {
			policyReasons.set(reason, (policyReasons.get(reason) ?? 0) + 1);
			continue;
		}
		// Not policy-excluded. Is it in the store at all? Present means the query dropped it (a real
		// finding); absent means the store does not have it (vintage, or an ingest gap).
		unexplained.push(row);
	}
	let presentButDropped = 0;
	let absentFromStoreCount = 0;
	for (const row of unexplained.slice(0, 4)) {
		if (await isAbsentFromStore(row.id)) absentFromStoreCount++;
		else presentButDropped++;
	}
	const fullyExplained = unexplained.length === 0 && onlyOurs.length === 0;
	const membershipClass: Classification = fullyExplained
		? "CORPUS-POLICY"
		: presentButDropped > 0
			? baseClass
			: unexplained.length > 0 && absentFromStoreCount > 0
				? "VINTAGE"
				: baseClass;

	// Past one page the two sides' windows hold different rows by construction, so page-1 evidence
	// cannot explain a total: the rows accounting for the difference may sit in a tail neither side
	// showed. Such a divergence is INCONCLUSIVE — real often enough to list, never enough to call.
	const multiPage = (theirsTotal ?? 0) > PAGE_SIZE || (oursTotal ?? 0) > PAGE_SIZE;

	if (oursTotal !== theirsTotal) {
		record({
			classification: multiPage && membershipClass !== "CORPUS-POLICY" ? "INCONCLUSIVE" : membershipClass,
			label: baseLabel || "total_cards",
			kind: "total_cards",
			detail:
				`scryfall total_cards=${theirsTotal} vs ours=${oursTotal} (delta ${
					theirsTotal !== undefined && oursTotal !== undefined ? oursTotal - theirsTotal : "?"
				})` +
				`; on this page ${onlyTheirs.length} row(s) only Scryfall has` +
				`${policyReasons.size > 0 ? ` [${[...policyReasons].map(([r, n]) => `${n}x ${r}`).join("; ")}]` : ""}` +
				`${unexplained.length > 0 ? `, ${unexplained.length} unexplained (e.g. ${describe(unexplained[0])}${presentButDropped > 0 ? ", PRESENT in this store" : ", absent from this store"})` : ""}`,
			caseName: c.name,
			path: c.path,
		});
	}
	if (oursBody.has_more !== theirsBody.has_more) {
		record({
			classification: membershipClass === "CORPUS-POLICY" ? "CORPUS-POLICY" : baseClass,
			label: baseLabel || "has_more",
			kind: "has_more",
			detail: `scryfall has_more=${String(theirsBody.has_more)} vs ours=${String(oursBody.has_more)} (totals ${theirsTotal}/${oursTotal})`,
			caseName: c.name,
			path: c.path,
		});
	}

	// 3. the ordered id list — the sorting oracle
	const order = analyzeOrder(oursIds, theirsIds);
	if (!order.sameOrder) {
		const i = order.firstDivergenceIndex;
		const orderParam = orderParamOf(c.path);
		const theirsRow = theirsById.get(order.theirsSeq[i] as string);
		const oursRow = oursById.get(order.oursSeq[i] as string);
		const theirsValue = sortValue(theirsRow, orderParam);
		const oursValue = sortValue(oursRow, orderParam);
		record({
			classification: VOLATILE_ORDERINGS.has(orderParam)
				? "VINTAGE"
				: flight
					? "IN-FLIGHT"
					: c.unsupported
						? "UNSUPPORTED"
						: "NEW",
			label: baseLabel || "ordering",
			kind: theirsValue === oursValue ? "ordering-tiebreak" : "ordering-primary",
			detail:
				`order=${orderParam}: at common-index ${i} scryfall has ${describe(theirsRow)} [${theirsValue}]` +
				` and ours has ${describe(oursRow)} [${oursValue}]` +
				`${theirsValue === oursValue ? " — SAME sort value, so the tiebreak differs" : " — DIFFERENT sort values, so the primary sort differs"}` +
				` (${order.commonCount} ids in common of ${theirsIds.length}/${oursIds.length} on the page)`,
			caseName: c.name,
			path: c.path,
		});
	}

	// 3b. the ordered ORACLE id list — the same oracle with representative choice factored out.
	// `unique=cards` returns ONE printing per card, and which printing that is comes from the
	// prefer score; a divergence there shows up as different ids in the same card order, which is a
	// different bug from a sort that puts the cards themselves in the wrong sequence.
	const oracleOrder = analyzeOrder(
		oursRows.map((r) => r.oracleId),
		theirsRows.map((r) => r.oracleId),
	);
	if (!order.sameOrder && oracleOrder.sameOrder) {
		record({
			classification: flight ? "IN-FLIGHT" : "NEW",
			label: baseLabel || "representative",
			kind: "representative-choice",
			detail: "the CARD order matches; only which printing represents each card differs (see the ordering finding)",
			caseName: c.name,
			path: c.path,
		});
	}
	if (order.sameOrder && (onlyTheirs.length > 0 || onlyOurs.length > 0)) {
		// Membership only matters as an exact statement when the whole result fit one page on both
		// sides; past that the page window itself moves.
		const exact = (theirsTotal ?? 0) <= PAGE_SIZE && (oursTotal ?? 0) <= PAGE_SIZE;
		// Same card, different printing, at the same rank: representative choice, not membership.
		const sameOracle = onlyTheirs.filter((r) => onlyOurs.some((o) => o.oracleId === r.oracleId));
		record({
			classification:
				sameOracle.length === onlyTheirs.length && onlyTheirs.length > 0
					? flight
						? "IN-FLIGHT"
						: "NEW"
					: exact
						? membershipClass
						: membershipClass === "CORPUS-POLICY"
							? "CORPUS-POLICY"
							: "INCONCLUSIVE",
			label: baseLabel || "membership",
			kind:
				sameOracle.length === onlyTheirs.length && onlyTheirs.length > 0
					? "representative-choice"
					: exact
						? "membership"
						: "page-window",
			detail:
				`${onlyTheirs.length} row(s) only Scryfall returned${
					policyReasons.size > 0 ? ` [${[...policyReasons].map(([r, n]) => `${n}x ${r}`).join("; ")}]` : ""
				}${unexplained.length > 0 ? `, ${unexplained.length} unexplained (e.g. ${describe(unexplained[0])}${presentButDropped > 0 ? ", PRESENT in this store" : ", absent from this store"})` : ""}` +
				`; ${onlyOurs.length} only ours${onlyOurs.length > 0 ? ` (e.g. ${describe(onlyOurs[0])})` : ""}` +
				`${sameOracle.length > 0 ? `; ${sameOracle.length} of them are the same CARD in a different printing` : ""}` +
				`${exact ? " — whole result fits one page, so this is exact" : " — result exceeds one page, so the window moved"}`,
			caseName: c.name,
			path: c.path,
		});
	}

	// 4. next_page shape
	const oursNext = nextPageShape(substituteOrigin(oursBody.next_page ?? null));
	const theirsNext = nextPageShape(theirsBody.next_page ?? null);
	// `include_extras` ALONE is a corpus-policy difference, not a next_page bug. Scryfall
	// auto-enables it — and echoes `true` — when a query scoped by PRINTING IDENTITY (set,
	// artist, watermark) matches at least one extra card. Measured 2026-08-16, and the rule
	// needs both halves: `e:lea` echoes true and `e:lea is:extra` is 1, while `e:khm` echoes
	// false and `e:khm is:extra` is 0 (Kaldheim's tokens live in `tkhm`); `a:guay` and
	// `watermark:mirran` echo true; and `t:creature`, `o:draw` and `ft:death` all echo FALSE
	// despite matching 1,742, 358 and 26 extras respectively, because none of them is scoped
	// that way. Sending `include_extras=false` explicitly does not turn it off.
	//
	// This port cannot reproduce it: `is:extra` is exactly the token/memorabilia/funny class
	// `passes_filters` never imports, so the count the rule keys on does not exist here. It is
	// classified rather than fixed, and would only become fixable by importing the printings the
	// corpus policy deliberately drops.
	const differsOnlyByExtras =
		oursNext !== undefined &&
		theirsNext !== undefined &&
		oursNext.replace("include_extras=false", "include_extras=true") === theirsNext;
	// `order=cubecobra` is THIS project's own ordering. Scryfall has no such order, resolves it to
	// `name`, and echoes `name`; this route serves it and must echo `cubecobra`, or `next_page`
	// would page 2 by name after page 1 came back by cubecobra. Serving the order correctly beats
	// echoing it identically, and there is no Scryfall behaviour to match for an order it does not
	// have. UNSUPPORTED rather than NEW, the same class as an operator probed on purpose.
	const differsOnlyByCubecobra =
		oursNext !== undefined &&
		theirsNext !== undefined &&
		oursNext.replace("order=cubecobra", "order=name") === theirsNext;
	if (oursNext !== theirsNext && (oursNext !== undefined || theirsNext !== undefined)) {
		record({
			classification: differsOnlyByExtras ? "CORPUS-POLICY" : differsOnlyByCubecobra ? "UNSUPPORTED" : baseClass,
			label: baseLabel || "next_page",
			kind: "next_page",
			detail: `scryfall next_page ${theirsNext ?? "(absent)"} vs ours ${oursNext ?? "(absent)"}`,
			caseName: c.name,
			path: c.path,
		});
	}

	// 5. warnings
	const oursWarn = Array.isArray(oursBody.warnings) ? oursBody.warnings : undefined;
	const theirsWarn = Array.isArray(theirsBody.warnings) ? theirsBody.warnings : undefined;
	if (canonical((oursWarn ?? null) as Json) !== canonical((theirsWarn ?? null) as Json)) {
		record({
			classification: c.unsupported ? "UNSUPPORTED" : baseClass,
			label: baseLabel || "warnings",
			kind: "warnings",
			detail: `scryfall warnings ${excerpt((theirsWarn ?? null) as Json)} vs ours ${excerpt((oursWarn ?? null) as Json)}`,
			caseName: c.name,
			path: c.path,
		});
	}

	// 6. byte-exact objects, free of charge
	compareObjects(c, oursBody, theirsBody);
}

// ─── the peripheral comparator ────────────────────────────────────────────────
//
// A different oracle from `runCase`'s, because the answers are different KINDS of thing. Five
// dimensions, each compared independently so a divergence names itself:
//
//   status                what the client's `if (res.ok)` reads
//   content-type          `text/csv` has no charset and `application/json` does; a client that
//                         switches on it sees the difference before it sees a byte of body
//   cache-control         the tier, which is behaviour a client observes for hours afterwards
//   content-disposition   present on CSV only, and it names the download
//   x-scryfall-has-more   the ONLY place a CSV client can learn there is another page
//   Location              on a `format=image` 302 the redirect target IS the answer
//   body                  JSON through live-parity's reduction; CSV structurally, per cell
//
// Response headers Scryfall sends that are its INFRASTRUCTURE rather than its API are not compared
// and not ledgered case by case: `nel`, `report-to`, `reporting-endpoints`, `via`, `x-action-cache`,
// `cf-*`, `age`, `server`, `x-download-options`, `x-permitted-cross-domain-policies`, `x-robots-tag`
// and the `content-transfer-encoding: binary` / `content-disposition: inline` pair Rails puts on
// every JSON body. Reproducing a Heroku router's telemetry headers is not parity with an API.
// `ETag`, `Last-Modified` and `Vary` are a deliberate omission with a reason (see the README).

/** Headers this comparator asks about. Everything else is infrastructure; see the note above. */
const COMPARED_HEADERS = [
	"content-type",
	"cache-control",
	"content-disposition",
	"x-scryfall-has-more",
	"location",
] as const;

/** `Content-Disposition: inline` is Rails boilerplate on every JSON body; only the CSV one means something. */
function comparableHeader(name: string, value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (name === "content-disposition" && value === "inline") return undefined;
	return value;
}

/** CSV columns whose VALUES move on their own, compared for presence rather than for content. */
const CSV_VOLATILE_COLUMNS = new Set(["usd_price", "usd_foil_price", "eur_price", "tix_price"]);

/**
 * Volatile columns Scryfall fills and this store never does, and how many joined rows agreed.
 *
 * Run-scoped rather than case-scoped, because the claim is about the store rather than about any
 * one query — see the tally in `compareCsv`.
 */
const emptyCsvColumns = new Map<string, number>();

/**
 * Split one CSV line into cells, RFC 4180. Small and local: the documents are ours and Scryfall's,
 * both minimally quoted, and pulling in a parser to read eighteen columns would be its own risk.
 */
function csvCells(line: string): string[] {
	const cells: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (quoted) {
			if (ch !== '"') cell += ch;
			else if (line[i + 1] === '"') {
				cell += '"';
				i++;
			} else quoted = false;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") {
			cells.push(cell);
			cell = "";
		} else cell += ch;
	}
	cells.push(cell);
	return cells;
}

/**
 * Compare two CSV documents: the header row exactly, then the rows both sides have, cell by cell.
 *
 * Rows are joined on `scryfall_id` rather than on position for the same reason the id-list oracle
 * restricts itself to the intersection — a printing the live API has and the local dump does not
 * would otherwise shift every later row and report eighteen columns as wrong. The image cell's
 * `?<image_updated_at>` cache-buster is cut before comparing, on the same volatility grounds the
 * card-object comparison strips it from `image_uris`.
 */
function compareCsv(theirsBody: string, oursBody: string, report: (kind: string, detail: string) => void): void {
	const theirsLines = theirsBody.split("\n").filter((l) => l.length > 0);
	const oursLines = oursBody.split("\n").filter((l) => l.length > 0);
	const theirsHeader = theirsLines[0] ?? "";
	const oursHeader = oursLines[0] ?? "";
	if (theirsHeader !== oursHeader) {
		report("csv-header", `scryfall header row ${theirsHeader}\n        ours              ${oursHeader}`);
		return;
	}
	if (!theirsBody.endsWith("\n") || !oursBody.endsWith("\n")) {
		report(
			"csv-trailing-newline",
			`scryfall ends with newline=${theirsBody.endsWith("\n")}, ours=${oursBody.endsWith("\n")}`,
		);
	}
	const columns = csvCells(theirsHeader);
	const idColumn = columns.indexOf("scryfall_id");
	const imageColumn = columns.indexOf("image_uri");
	const rowsOfCsv = (lines: string[]): Map<string, string[]> => {
		const out = new Map<string, string[]>();
		for (const line of lines.slice(1)) {
			const cells = csvCells(line);
			// A duplicated identifier legitimately produces a repeated row, so first-wins keeps the
			// join deterministic rather than asserting uniqueness the format does not promise.
			const id = cells[idColumn] ?? "";
			if (!out.has(id)) out.set(id, cells);
		}
		return out;
	};
	const theirsRows = rowsOfCsv(theirsLines);
	const oursRows = rowsOfCsv(oursLines);
	if (theirsLines.length !== oursLines.length) {
		report("csv-row-count", `scryfall ${theirsLines.length - 1} data rows, ours ${oursLines.length - 1}`);
	}
	let compared = 0;
	const reported = new Set<string>();
	for (const [id, theirsCells] of theirsRows) {
		const oursCells = oursRows.get(id);
		if (oursCells === undefined) continue;
		compared++;
		for (let col = 0; col < columns.length; col++) {
			const column = columns[col] as string;
			if (CSV_VOLATILE_COLUMNS.has(column)) continue;
			let theirsCell = theirsCells[col] ?? "";
			let oursCell = oursCells[col] ?? "";
			if (col === imageColumn) {
				theirsCell = theirsCell.split("?")[0] ?? theirsCell;
				oursCell = oursCell.split("?")[0] ?? oursCell;
			}
			if (theirsCell === oursCell || reported.has(column)) continue;
			reported.add(column);
			report(
				"csv-cell",
				`column \`${column}\` on row ${id}: scryfall ${theirsCell || "(empty)"} / ours ${oursCell || "(empty)"}`,
			);
		}
	}
	if (compared === 0 && theirsRows.size > 0) {
		report("csv-no-common-rows", `${theirsRows.size} scryfall rows and ${oursRows.size} of ours share no id`);
	}
	// The volatile price columns still say something structural: a column EMPTY on every one of our
	// rows and populated on Scryfall's is not price movement, it is a field this store does not
	// carry. That is exactly how `usd_foil_price` was found on 2026-08-16.
	for (const column of CSV_VOLATILE_COLUMNS) {
		const col = columns.indexOf(column);
		if (col < 0) continue;
		let theirsFilled = 0;
		let oursFilled = 0;
		let joined = 0;
		for (const [id, theirsCells] of theirsRows) {
			const oursCells = oursRows.get(id);
			if (oursCells === undefined) continue;
			joined++;
			if ((theirsCells[col] ?? "") !== "") theirsFilled++;
			if ((oursCells[col] ?? "") !== "") oursFilled++;
		}
		// ONCE PER RUN, not once per case: this is a statement about the STORE, and every CSV case
		// that joins five rows would otherwise repeat it and bury the case-specific findings. The
		// first case to see it reports it with its own evidence; the rest add to the tally the
		// summary prints.
		if (joined >= 5 && theirsFilled >= 3 && oursFilled === 0) {
			emptyCsvColumns.set(column, (emptyCsvColumns.get(column) ?? 0) + joined);
			if (emptyCsvColumns.get(column) === joined) {
				report(
					"csv-column-never-populated",
					`column \`${column}\` is set on ${theirsFilled} of ${joined} shared rows at Scryfall and on NONE of ours — a field this store does not carry, not price movement (reported once per run; see the summary for the run total)`,
				);
			}
		}
	}
}

/**
 * A path decoded for the log, or left as written when it cannot be.
 *
 * The `http` family probes MALFORMED escapes on purpose (`/cards/%zz`), and `decodeURIComponent`
 * throws on those — which took the whole run down at the line that was printing the case name.
 */
function readablePath(path: string): string {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

/** Do two `data` arrays hold the same values, ignoring order? Non-arrays are never the same. */
function sameMultiset(a: Json | undefined, b: Json | undefined): boolean {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return false;
	const key = (v: Json): string => canonical(v);
	const counts = new Map<string, number>();
	for (const item of a) counts.set(key(item as Json), (counts.get(key(item as Json)) ?? 0) + 1);
	for (const item of b) {
		const k = key(item as Json);
		const left = counts.get(k);
		if (left === undefined || left === 0) return false;
		counts.set(k, left - 1);
	}
	return [...counts.values()].every((n) => n === 0);
}

async function runPeripheralCase(c: PeripheralCase): Promise<void> {
	const method = c.method ?? "GET";
	const ours = await fetchOurs(c.path, method, c.body);
	const theirs = await fetchScryfall(c.path, method, c.body, true);
	const baseClass: Classification = c.ledger ? "LEDGERED" : "NEW";
	const report = (kind: string, detail: string): void =>
		record({
			classification: baseClass,
			label: c.group,
			kind,
			detail: c.ledger ? `${detail} — LEDGERED: ${c.ledger}` : detail,
			caseName: c.name,
			path: `${method} ${c.path}`,
		});

	if (ours.status !== theirs.status) {
		report("status", `scryfall ${theirs.status}, ours ${ours.status}`);
	}
	for (const header of COMPARED_HEADERS) {
		const theirsValue = comparableHeader(header, theirs.headers?.[header]);
		const oursValue = comparableHeader(header, ours.headers?.[header]);
		if (theirsValue === oursValue) continue;
		// A `Location` differing only by the image cache-buster is the `image_updated_at` gap, which
		// has its own finding through the CSV column check; reporting it once per image case would
		// bury everything else. And `/cards/random` redirects to a DIFFERENT card per call, so its
		// Location is not a comparable value at all.
		if (header === "location" && c.path.startsWith("/cards/random")) continue;
		if (header === "location" && (theirsValue ?? "").split("?")[0] === (oursValue ?? "").split("?")[0]) continue;
		report(`header:${header}`, `scryfall ${theirsValue ?? "(absent)"}, ours ${oursValue ?? "(absent)"}`);
	}
	if (method === "HEAD") return;

	const theirsType = (theirs.headers?.["content-type"] ?? "").split(";")[0]?.trim();
	if (theirsType === "text/csv") {
		compareCsv(theirs.body, ours.body, report);
		return;
	}
	if (theirsType !== "application/json") return;

	const theirsJson = parse(theirs.body);
	const oursJson = parse(ours.body);
	if (!isObject(theirsJson) || !isObject(oursJson)) {
		if (theirs.body.trim() !== ours.body.trim()) report("body", `scryfall ${excerpt(theirs.body as Json)}`);
		return;
	}
	// An ERROR or MESSAGE body is compared as BYTES, not as a document: it is small, every one of
	// its four keys is a string a client may match on, and Scryfall pretty-prints these where it
	// serves data compact — a whitespace difference that no parsed comparison can see and every
	// byte-comparing client can.
	if (theirsJson.object === "error" || theirsJson.object === "message") {
		if (theirs.body !== ours.body) {
			report(
				"error-body",
				`scryfall ${JSON.stringify(theirs.body).slice(0, 200)}\n        ours     ${JSON.stringify(ours.body).slice(0, 200)}`,
			);
		}
		return;
	}
	// /cards/random answers a different card per call, so only its shape is comparable.
	if (c.path.startsWith("/cards/random")) {
		if (Object.keys(theirsJson).length > 0 && oursJson.object !== theirsJson.object) {
			report("object", `scryfall object=${String(theirsJson.object)}, ours ${String(oursJson.object)}`);
		}
		return;
	}
	const oursReduced = stripPatternKeys(stripVolatileSpecials(substituteOrigin(oursJson)), volatilePatterns);
	const theirsReduced = stripAffiliateDecoration(
		stripPatternKeys(stripPatternKeys(stripVolatileSpecials(theirsJson), volatilePatterns), ledgerPatterns),
	);
	if (canonical(oursReduced) === canonical(theirsReduced)) return;
	// A reference payload that is the same MULTISET in a different order is a MIRROR-VINTAGE fact,
	// not an ordering bug. scripts/seed-reference.ts copies Scryfall's array elements as raw text and
	// never sorts them (`rawArrayElements`), so this port structurally cannot reorder one — the only
	// way the sequences can differ is that Scryfall's own order changed since the last import. Seen
	// on `/catalog/powers`, where `"2"` and `"+2"` swapped places.
	const mirrored = c.group === "reference" && !c.path.startsWith("/cards/");
	if (mirrored && sameMultiset(theirsJson.data, oursJson.data)) {
		record({
			classification: "VINTAGE",
			label: c.group,
			kind: "reference-order",
			detail: `\`data\` holds the same ${Array.isArray(theirsJson.data) ? theirsJson.data.length : "?"} values in a different order — this port mirrors Scryfall's array bytes verbatim, so the order changed at the source since the last reference import`,
			caseName: c.name,
			path: `${method} ${c.path}`,
		});
		return;
	}
	const diffs: Diff[] = [];
	collectDiffs(theirsReduced, oursReduced, [], diffs);
	for (const diff of diffs.slice(0, 6)) {
		const known = knownDeviationFor(diff.path);
		const flight = known ? undefined : inFlightForPath(diff.path);
		record({
			classification: known ? "KNOWN" : flight ? "IN-FLIGHT" : baseClass,
			label: known?.name ?? flight?.name ?? c.group,
			kind: "object",
			detail: `${diff.path.join(".") || "(root)"}: scryfall ${excerpt(diff.scryfall)} / ours ${excerpt(diff.ours)}${c.ledger ? ` — LEDGERED: ${c.ledger}` : ""}`,
			caseName: c.name,
			path: `${method} ${c.path}`,
		});
	}
}

// ─── pagination depth ─────────────────────────────────────────────────────────

interface PageFetch {
	ids: string[];
	rows: Row[];
	total?: number;
	hasMore?: boolean;
	next?: string;
	status: number;
}

async function fetchPage(path: string): Promise<{ ours: PageFetch; theirs: PageFetch }> {
	const ours = await fetchOurs(path);
	const theirs = await fetchScryfall(path);
	const shape = (f: Fetched): PageFetch => {
		const body = parse(f.body);
		const obj = body && isObject(body) ? body : undefined;
		return {
			ids: idsOf(body),
			rows: rowsOf(body),
			total: obj && typeof obj.total_cards === "number" ? obj.total_cards : undefined,
			hasMore: obj && typeof obj.has_more === "boolean" ? obj.has_more : undefined,
			next: typeof obj?.next_page === "string" ? obj.next_page : undefined,
			status: f.status,
		};
	};
	pagesCompared++;
	return { ours: shape(ours), theirs: shape(theirs) };
}

function pathOf(url: string): string {
	const u = new URL(url);
	return `${u.pathname}${u.search}`;
}

async function runPageWalk(walk: PageWalk): Promise<void> {
	const base = search(walk.q, walk.params);
	const first = await fetchPage(base);
	const total = first.theirs.total ?? first.ours.total ?? 0;
	const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const caseName = `page-${walk.name}`;

	const walkCase: SweepCase = { name: caseName, group: "pagination", path: base, covers: [] };
	const orderParam = walk.params.order ?? "name";
	// `dir` is resolved the way the route resolves it: an absent or `auto` direction means DESC for
	// the five orderings AUTO_DESCENDING_ORDERINGS names, and a monotonicity check that assumed
	// ascending would report every `order=released` page as broken.
	const descending =
		resolveDirection((walk.params.dir ?? "auto") as SortDirection, orderParam as CardOrdering) === "desc";

	/**
	 * Is OUR OWN page monotone in its own ordering?
	 *
	 * This needs no reference at all, which is what makes it the sharpest test of the two-phase
	 * gather: the k-way merge (src/engine/gather.ts) claims to interleave per-partition key streams
	 * into one globally sorted sequence, so a page that is not monotone in its own sort column is a
	 * merge bug no matter what Scryfall thinks. Comparable columns only — `set` needs the engine's
	 * collector-number rule and `color`/`rarity` need its rank tables, so those are skipped rather
	 * than guessed at.
	 */
	const selfSortCheck = (label: string, rows: Row[], pageNo: number): void => {
		const numeric = ["cmc", "usd", "eur", "tix", "power", "toughness", "edhrec"].includes(orderParam);
		if (!numeric && !["name", "artist", "released"].includes(orderParam)) return;
		// `name` and `artist` are COLLATED, not compared as raw bytes: accents folded and every
		// non-alphanumeric dropped, the rule `collate_name` applies to `name_rank`/`artist_rank`
		// and the one api.scryfall.com demonstrably uses.
		//
		// Comparing lowercased bytes here reported six correct pages as broken, because a name's
		// divergence point is so often punctuation: `Dawnhart Wardens` before `Dawn's Light
		// Archer`, `Goblin Skycutter` before `Goblin Sky Raider`, `Zada, Hedron Grinder` before
		// `Zada's Commando`, `Mayael the Anima` before `M'Baku, Jabari Chieftain`, `Redtooth
		// Genealogist` before `Red XIII, Proud Warrior`. All five pairs were put to Scryfall
		// directly on 2026-08-16 (`!"A" or !"B"`, `order=name`) and it answers OUR order in every
		// one. A self-sort check that does not use the sort's own rule is not checking the sort.
		const collated = ["name", "artist"].includes(orderParam);
		const key = (v: string): string =>
			collated ? [...foldAccents(v.toLowerCase())].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join("") : v.toLowerCase();
		for (let i = 1; i < rows.length; i++) {
			const a = sortValue(rows[i - 1], orderParam);
			const b = sortValue(rows[i], orderParam);
			if (a === "null" || b === "null" || a === "undefined" || b === "undefined" || a === "?" || b === "?") continue;
			const cmp = numeric ? Number(a) - Number(b) : key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
			if (descending ? cmp < 0 : cmp > 0) {
				record({
					classification: "NEW",
					label: "self-sort",
					kind: "self-sort-violation",
					detail: `${label} (page ${pageNo}, order=${orderParam}${descending ? " desc" : ""}): OUR OWN page is not monotone at row ${i} — ${describe(rows[i - 1])} [${a}] precedes ${describe(rows[i])} [${b}]`,
					caseName,
					path: base,
				});
				return;
			}
		}
	};

	const check = (label: string, ours: PageFetch, theirs: PageFetch, pageNo: number): void => {
		selfSortCheck(label, ours.rows, pageNo);
		const order = analyzeOrder(ours.ids, theirs.ids);
		if (!order.sameOrder) {
			const i = order.firstDivergenceIndex;
			const theirsRow = theirs.rows.find((r) => r.id === order.theirsSeq[i]);
			const oursRow = ours.rows.find((r) => r.id === order.oursSeq[i]);
			const theirsValue = sortValue(theirsRow, orderParam);
			const oursValue = sortValue(oursRow, orderParam);
			record({
				classification: VOLATILE_ORDERINGS.has(orderParam)
					? "VINTAGE"
					: inFlightForCase(walkCase)
						? "IN-FLIGHT"
						: "NEW",
				label: "pagination-ordering",
				kind: theirsValue === oursValue ? "ordering-tiebreak" : "ordering-primary",
				detail:
					`${label} (page ${pageNo}, order=${orderParam}): common ids reordered at index ${i} (global row ${(pageNo - 1) * PAGE_SIZE + i})` +
					` — scryfall ${describe(theirsRow)} [${theirsValue}], ours ${describe(oursRow)} [${oursValue}]` +
					`${theirsValue === oursValue ? " — SAME sort value, tiebreak differs" : " — DIFFERENT sort values, primary sort differs"}`,
				caseName,
				path: base,
			});
		}
		// A page-length or has_more difference is only a statement about pagination when the two
		// sides agree on how many rows there are; when the totals differ the last page is short on
		// one side for the same reason the total is smaller, which the total finding already says.
		const totalsAgree = ours.total === theirs.total;
		if (ours.ids.length !== theirs.ids.length) {
			record({
				classification: totalsAgree ? "NEW" : "INCONCLUSIVE",
				label: "pagination-length",
				kind: "page-length",
				detail: `${label} (page ${pageNo}): scryfall returned ${theirs.ids.length} rows, ours ${ours.ids.length}`,
				caseName,
				path: base,
			});
		}
		if (ours.hasMore !== theirs.hasMore) {
			record({
				classification: totalsAgree ? "NEW" : "INCONCLUSIVE",
				label: "pagination-has_more",
				kind: "has_more",
				detail: `${label} (page ${pageNo}): scryfall has_more=${String(theirs.hasMore)} vs ours=${String(ours.hasMore)}`,
				caseName,
				path: base,
			});
		}
	};

	check("page 1", first.ours, first.theirs, 1);

	// Page 2 is followed through next_page on BOTH sides, so the link itself is under test.
	const seen = new Map<string, number>();
	for (const [i, id] of first.ours.ids.entries()) seen.set(id, i);

	if (first.ours.next && first.theirs.next) {
		const second = await fetchPage(pathOf(first.ours.next));
		check("page 2 via next_page", second.ours, second.theirs, 2);
		// Boundary continuity, ours alone: an id repeated across the boundary, or a hole, is a
		// merge bug that needs no reference to prove.
		for (const id of second.ours.ids) {
			if (seen.has(id)) {
				record({
					classification: "NEW",
					label: "pagination-duplicate",
					kind: "duplicate-across-pages",
					detail: `id ${id} appears on both page 1 (index ${seen.get(id)}) and page 2`,
					caseName,
					path: base,
				});
			}
		}
		selfSortCheck("pages 1+2 concatenated", [...first.ours.rows, ...second.ours.rows], 1);
		// The concatenated sequence must equal Scryfall's concatenated sequence.
		const oursCat = [...first.ours.ids, ...second.ours.ids];
		const theirsCat = [...first.theirs.ids, ...second.theirs.ids];
		const catOrder = analyzeOrder(oursCat, theirsCat);
		if (!catOrder.sameOrder) {
			record({
				classification: "NEW",
				label: "pagination-boundary",
				kind: "ordering",
				detail: `pages 1+2 concatenated diverge at common-index ${catOrder.firstDivergenceIndex} (page boundary is index ${PAGE_SIZE})`,
				caseName,
				path: base,
			});
		}
	}

	const targets = new Set<number>(walk.extra ?? []);
	if (lastPage > 2) targets.add(Math.max(2, Math.ceil(lastPage / 2)));
	if (lastPage > 1) targets.add(lastPage);
	for (const pageNo of [...targets].sort((a, b) => a - b)) {
		if (pageNo <= 1 || pageNo > lastPage) continue;
		const p = await fetchPage(`${base}&page=${pageNo}`);
		check(pageNo === lastPage ? "last page" : "deep page", p.ours, p.theirs, pageNo);
	}
}

// ─── main ─────────────────────────────────────────────────────────────────────

const selected = cases.filter((c) => (!only || c.name.includes(only)) && (!group || c.group === group)).slice(0, limit);

// `--dump-cases`: the matrix as data, and then stop. Placed HERE — after generation, before the
// first request — so a dump costs nobody a Scryfall call. `--only`/`--group`/`--limit` narrow it
// exactly as they narrow a run.
if (dumpCases) {
	mkdirSync(dirname(dumpCases), { recursive: true });
	writeFileSync(dumpCases, JSON.stringify(selected, null, 2));
	console.log(`parity-sweep: wrote ${selected.length} of ${cases.length} cases to ${dumpCases}`);
	process.exit(0);
}

const selectedPeripheral = peripheral
	.filter((c) => (!only || c.name.includes(only)) && (!group || c.group === group))
	.slice(0, limit);

console.log(`parity-sweep: ${origin}  vs  ${SCRYFALL_ORIGIN}`);
console.log(
	`matrix: ${cases.length} query cases (${selected.length} selected), ${peripheral.length} peripheral cases (${selectedPeripheral.length} selected), ${PAGE_WALKS.length} page walks`,
);
const byGroup = new Map<string, number>();
for (const c of cases) byGroup.set(c.group, (byGroup.get(c.group) ?? 0) + 1);
for (const c of peripheral) byGroup.set(c.group, (byGroup.get(c.group) ?? 0) + 1);
console.log(`groups: ${[...byGroup].map(([g, n]) => `${g}=${n}`).join(" ")}`);

// ── the harness's own reach, before a single divergence is measured ──
//
// Two checks, both about what this file is ABLE to see rather than about what it saw:
//
//   * the reach grid, which is static and costs nothing;
//   * anchor adequacy, one request per (anchor, feature) pair against OUR origin only. Scryfall
//     never sees these — a vacuous anchor is a fact about the matrix, and the local store answers
//     it for free.
//
// Both are skipped under `--only` / `--group`, where the matrix is a slice and an "empty cell"
// means nothing.
if (!only && !group) {
	console.log(`\n─── harness reach ───`);
	for (const { axis, cells } of reachGrid) {
		const entries = Object.entries(cells).sort((a, b) => b[1] - a[1]);
		console.log(`  ${axis}: ${entries.length} populated cell(s)`);
		console.log(`      ${entries.map(([cell, n]) => `${cell}=${n}`).join("  ")}`);
	}
	console.log(`  required cells: ${REQUIRED_CELLS.length}, declared unreachable: ${UNREACHABLE_CELLS.length}`);
	for (const problem of reachProblems)
		record({
			classification: "BLIND-SPOT",
			label: "reach",
			kind: "uncovered-cell",
			detail: problem,
			caseName: "(matrix)",
			path: "(matrix)",
		});

	console.log(`  anchor adequacy: ${anchorProbes.length} (anchor, feature) pair(s) against ${origin}`);
	const anchorTotals = new Map<string, number>();
	const totalFor = async (q: string): Promise<number> => {
		const cached = anchorTotals.get(q);
		if (cached !== undefined) return cached;
		const body = parse((await fetchOurs(search(q))).body);
		const total = isObject(body) && typeof body.total_cards === "number" ? body.total_cards : 0;
		anchorTotals.set(q, total);
		return total;
	};
	let vacuous = 0;
	for (const probe of anchorProbes) {
		const matching = await totalFor(`${probe.anchor} ${probe.feature}`);
		const where = probe.caseNames.join(", ");
		let problem: string | undefined;
		if (matching === 0) {
			problem = `the anchor \`${probe.anchor}\` contains no row matching \`${probe.feature}\`, so the probe compares an empty list against an empty list`;
		} else if (probe.negated) {
			// A negated probe needs the anchor SPLIT by the feature. `-frame:2015 e:khm` over a set
			// whose every printing is a 2015 frame answers 0 either way, and a rule that dropped the
			// negation entirely would answer 0 too — the same shape as the tautology family that
			// went unseen for the life of this file.
			const anchorTotal = await totalFor(probe.anchor);
			if (anchorTotal > 0 && matching >= anchorTotal)
				problem = `every one of \`${probe.anchor}\`'s ${anchorTotal} rows matches \`${probe.feature}\`, so negating it removes the whole anchor and a dropped negation is indistinguishable from an honored one`;
		}
		const exemption = ANCHOR_EXEMPTIONS.find((e) => e.anchor === probe.anchor && e.feature === probe.feature);
		if (exemption) {
			// A stale exemption is a finding of its own: it claims the probe CANNOT be adequate, and
			// the measurement just said otherwise.
			if (!problem)
				record({
					classification: "BLIND-SPOT",
					label: "anchor",
					kind: "stale-exemption",
					detail: `\`${probe.anchor}\` / \`${probe.feature}\` is exempted as structurally vacuous, but it now discriminates — the exemption's reason no longer holds.`,
					caseName: probe.caseNames[0] as string,
					path: search(`${probe.anchor} ${probe.feature}`),
				});
			continue;
		}
		if (!problem) continue;
		vacuous++;
		record({
			classification: "BLIND-SPOT",
			label: "anchor",
			kind: "vacuous-anchor",
			detail: `${where}: ${problem} — the probe cannot observe the feature it names.`,
			caseName: probe.caseNames[0] as string,
			path: search(`${probe.anchor} ${probe.feature}`),
		});
	}
	console.log(`  ${vacuous} inadequate anchor(s), ${ANCHOR_EXEMPTIONS.length} declared exemption(s)`);
}

const startedAt = Date.now();
for (const [i, c] of selected.entries()) {
	const before = findings.length;
	try {
		await runCase(c);
	} catch (err) {
		record({
			classification: "NEW",
			label: "harness",
			kind: "error",
			detail: String(err),
			caseName: c.name,
			path: c.path,
		});
	}
	const added = findings.slice(before);
	const worst = added.some((f) => f.classification === "NEW")
		? "NEW"
		: added.length > 0
			? (added[0] as Finding).classification
			: "ok";
	const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
	console.log(
		`[${String(i + 1).padStart(3)}/${selected.length}] ${elapsed}s ${worst.padEnd(11)} ${c.name}  ${decodeURIComponent(c.path).slice(0, 90)}`,
	);
	for (const f of added) console.log(`        ${f.classification} ${f.kind}: ${f.detail}`);
}

// The PERIPHERAL families (formats / reference / http). Run after the query matrix rather than
// interleaved so a `--group formats` run and a full run print the same block in the same place.
if (selectedPeripheral.length > 0) {
	console.log(`\nperipheral surface: ${selectedPeripheral.length} cases`);
	for (const [i, c] of selectedPeripheral.entries()) {
		const before = findings.length;
		try {
			await runPeripheralCase(c);
		} catch (err) {
			record({
				classification: "NEW",
				label: "harness",
				kind: "error",
				detail: String(err),
				caseName: c.name,
				path: c.path,
			});
		}
		const added = findings.slice(before);
		const worst = added.some((f) => f.classification === "NEW")
			? "NEW"
			: added.length > 0
				? (added[0] as Finding).classification
				: "ok";
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
		console.log(
			`[${String(i + 1).padStart(3)}/${selectedPeripheral.length}] ${elapsed}s ${worst.padEnd(11)} ${c.name}  ${c.method ?? "GET"} ${readablePath(c.path).slice(0, 70)}`,
		);
		for (const f of added) console.log(`        ${f.classification} ${f.kind}: ${f.detail}`);
	}
}

if (runPages && !only && !group) {
	console.log(`\npagination depth: ${PAGE_WALKS.length} walks`);
	for (const walk of PAGE_WALKS) {
		const before = findings.length;
		try {
			await runPageWalk(walk);
		} catch (err) {
			record({
				classification: "NEW",
				label: "harness",
				kind: "error",
				detail: String(err),
				caseName: `page-${walk.name}`,
				path: search(walk.q, walk.params),
			});
		}
		const added = findings.slice(before);
		console.log(`    ${added.length === 0 ? "ok  " : "DIFF"} ${walk.name} (${added.length} finding(s))`);
		for (const f of added) console.log(`        ${f.classification} ${f.kind}: ${f.detail}`);
	}
}

// ─── report ───────────────────────────────────────────────────────────────────

// The run-level half of the volatile-shape guard: a price key (or the whole image cache-buster)
// that Scryfall served broadly and this mirror never served once. No single case can see it, so it
// is folded in here, before the findings are counted.
for (const problem of volatileShapeRunProblems(shapeTally))
	record({
		classification: "NEW",
		label: "volatile-shape",
		kind: "volatile-shape-run",
		detail: problem,
		caseName: "(run)",
		path: "(run)",
	});

const counts = new Map<Classification, number>();
for (const f of findings) counts.set(f.classification, (counts.get(f.classification) ?? 0) + 1);
for (const stat of objectPathStats.values())
	counts.set(
		`obj:${stat.classification}` as Classification,
		(counts.get(`obj:${stat.classification}` as Classification) ?? 0) + 1,
	);

console.log(`\n─── summary ───`);
console.log(
	`cases run: ${selected.length} query + ${selectedPeripheral.length} peripheral; pages compared: ${pagesCompared}; objects byte-compared: ${objectsCompared}`,
);
console.log(`scryfall requests: ${scryfallRequests} (cache hits: ${cacheHits})`);
console.log(volatileShapeSummary(shapeTally));
if (emptyCsvColumns.size > 0) {
	console.log(
		`csv columns Scryfall fills and this store never does: ${[...emptyCsvColumns]
			.map(([column, rows]) => `${column} (${rows} joined rows)`)
			.join(", ")}`,
	);
}
for (const [k, v] of [...counts].sort()) console.log(`  ${k}: ${v}`);

const report = {
	generatedAt: new Date().toISOString(),
	origin,
	matrix: {
		cases: cases.length,
		selected: selected.length,
		peripheralCases: peripheral.length,
		peripheralSelected: selectedPeripheral.length,
		peripheralCovers: peripheral.flatMap((c) => c.covers),
		groups: Object.fromEntries(byGroup),
		// The standing statement of reach: the observed grid, what is required of it, what is
		// deliberately outside it, and the anchors every templated probe leans on.
		reach: {
			grid: reachGrid,
			required: REQUIRED_CELLS,
			unreachable: UNREACHABLE_CELLS,
			problems: reachProblems,
			anchorProbes: anchorProbes.length,
			anchorExemptions: ANCHOR_EXEMPTIONS,
			enumDomains: ENUM_DOMAINS,
			enumDomainCases,
		},
		columnsCovered,
		aliasesCovered: [...new Set(aliasesCovered)],
		ordersCovered: orderCovered,
		uniquesCovered: UNIQUE_SPELLINGS,
		langsCovered: LANGS,
		pageWalks: PAGE_WALKS.map((w) => w.name),
	},
	stats: {
		pagesCompared,
		objectsCompared,
		scryfallRequests,
		cacheHits,
		counts: Object.fromEntries(counts),
	},
	findings,
	objectPaths: [...objectPathStats].map(([path, s]) => ({ path, ...s })),
};

mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, "parity-sweep-results.json");
writeFileSync(jsonPath, JSON.stringify(report, null, 2));
console.log(`\nresults: ${jsonPath}`);

// Printed BEFORE the NEW count and separately from it: these are not divergences, and a reader who
// takes them for a regression will "fix" the harness by deleting the check that found them.
const blindSpots = findings.filter((f) => f.classification === "BLIND-SPOT");
if (blindSpots.length > 0) {
	console.log(`\nHARNESS BLIND SPOTS: ${blindSpots.length} (not divergences — things this sweep cannot see)`);
	for (const f of blindSpots) console.log(`  ${f.kind}: ${f.detail}`);
}

const newFindings = findings.filter((f) => f.classification === "NEW");
const newObjectPaths = [...objectPathStats].filter(([, s]) => s.classification === "NEW");
console.log(`NEW findings: ${newFindings.length} list-level, ${newObjectPaths.length} object paths`);
for (const [path, s] of newObjectPaths) console.log(`  object ${path} x${s.count}: ${s.example}`);
