// Live parity: the deployed mirror against api.scryfall.com, byte for byte.
//
//   TRUSTED_API_KEY=... bun scripts/live-parity.ts \
//       [--origin <url>] [--cases <path>] [--only <substr>] [--include-pending] [--key <k>]
//
// The offline gates prove the mirror agrees with its own fixtures; this proves the fixtures agree
// with Scryfall. Every case fetches the SAME path from both origins and requires the bodies to be
// byte-identical after a fixed, deliberate set of reductions (plan C4):
//
//   1. parse both bodies
//   2. strip volatile fields from both sides: every value under `prices` (all of them move daily),
//      `edhrec_rank`, `penny_rank`, and the `?<timestamp>` cache-buster on every `image_uris`
//      value (top-level and per-face) — the PATH of the image still has to match. What that
//      reduction cannot see is checked STRUCTURALLY instead, by scripts/volatile-shape.ts: the KEY
//      SETS of `prices` and `image_uris` must match Scryfall's exactly, prices the mirror serves
//      must be decimal strings, an image URL Scryfall cache-busts the mirror must cache-bust too,
//      and neither a price key nor a rank key may be dead across a whole run. That module exists
//      because this step hid three real bugs (null foil prices, missing cache-busters, and five
//      missing `image_uris` sizes) for the harness's entire life; read its header before widening
//      the reduction again
//   3. strip LEDGERED Scryfall-only keys from Scryfall's side only. The ledger is the cases file's
//      `scryfall_only_keys` (plus per-case additions): keys api.scryfall.com serves that upstream
//      #912 has no column for. An UNLISTED key Scryfall sends and the mirror does not is a
//      FAILURE, with instructions to ledger it — the ledger grows deliberately, never silently
//   4. normalize Scryfall's affiliate decoration: api.scryfall.com wraps `purchase_uris` and the
//      tcgplayer `related_uris` in partner redirects and tracking params the bulk data does not
//      carry (partner.tcgplayer.com/...?u=<real url>, utm_*, affiliate_id, referrer, ref). The
//      wrapper is unwrapped and the tracking params dropped so the UNDERLYING url still compares —
//      the same treatment as the image cache-buster
//   5. canonicalize both remainders — recursive key sort (the repo's parity definition is
//      upstream's key order, not api.scryfall.com's), then serialize through stringifyScryfall so
//      decimal wire forms (`"cmc":1.0`) compare by this port's own rule
//   6. require byte equality
//
// A byte difference is then classified, not just reported:
//
//   - covered by a FIELD DEVIATION (the cases file's `field_deviations`: named, documented,
//     path-scoped divergences like the slug percent-encoding gap plan C3 fixes) -> the case stays
//     green and the deviation names are printed; entries with a `normalize` rule additionally
//     assert the RECORDED relationship between the two sides (percent-decode equality, case-folded
//     set equality) and report a broken recording as DRIFT, not a pass
//   - a KNOWN_DEVIATION case (e.g. fuzzy "red goad", Decision 7) skips the byte diff entirely and
//     asserts each side's recorded behavior separately; a side that no longer matches its
//     recording is DRIFT
//   - anything else is a FAILURE
//
// Exit code: 0 all green, 1 any failure, 2 only known-deviation drift.
//
// Politeness to api.scryfall.com is non-negotiable: cases run serially, Scryfall requests keep a
// 100ms minimum gap, Retry-After on 429 is honored, the User-Agent identifies this project
// (Scryfall 403s generic agents), and every Scryfall response is cached on disk for the rest of
// the day, so a red/green iteration loop costs Scryfall one request per case per day.
//
// This is a standalone script, NOT a test under tests/ — bunfig pins the test root and tests/
// holds a no-network invariant that this file exists to violate on purpose.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringifyScryfall } from "../src/routes/scryfall-compat/respond";
import {
	checkVolatileShape,
	newVolatileShapeTally,
	volatileShapeRunProblems,
	volatileShapeSummary,
} from "./volatile-shape";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCRYFALL_ORIGIN = "https://api.scryfall.com";

/** The first of verify-deploy.ts's DEFAULT_ORIGINS — the deployment users actually hit. */
const DEFAULT_ORIGIN = "https://sylvan-librarian.daveycodez.workers.dev";

/** Identifies this project to Scryfall; a generic agent gets 403'd. */
const USER_AGENT = "sylvan-live-parity/1.0 (+https://github.com/jbylund/sylvan_librarian)";

/**
 * The per-IP limiter's bypass key, read from the environment — NEVER written down here.
 *
 * This harness talks to the deployment the same way a script does: a few hundred cache-missing
 * engine requests, back to back, from one address. That is exactly the shape the limiter exists to
 * stop, and once RATE_LIMIT_ENABLED was turned on in production every case here came back `ours
 * 429` — 68 failures in one run, none of them about parity. A verification that cannot tell "the
 * mirror disagrees with Scryfall" from "the mirror refused to answer me" is worse than no
 * verification, because the plan of record runs this against PRODUCTION right after a deploy and
 * again across three nightlies.
 *
 * `TRUSTED_API_KEY` and the `X-API-Key` header are the convention load-test.ts and
 * bench-cards-search.ts already use, and `isTrustedRequest` (src/routes/rate-limit.ts) checks the
 * presented value against the `TRUSTED_API_KEYS` LIST the Worker holds — one key per caller, so
 * this harness can hold its own and be revoked alone. The value only ever lives in the
 * environment; passing --key is for a one-off shell where exporting is inconvenient.
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

/** Minimum spacing between requests to api.scryfall.com. */
const MIN_SCRYFALL_GAP_MS = 100;

/**
 * Per-day Scryfall response cache. Defaults into the session scratchpad this harness was built
 * under; point LIVE_PARITY_CACHE_DIR anywhere writable to relocate it.
 */
const CACHE_ROOT =
	process.env.LIVE_PARITY_CACHE_DIR ??
	"/private/tmp/claude-501/-Users-david-Developer-sylvan-librarian-cloudflare/1f7f7129-b296-412e-9176-54db930fba01/scratchpad/live-parity-cache";

/** Volatile leaf keys stripped from BOTH sides anywhere they appear (plan C4). */
const VOLATILE_KEYS = ["edhrec_rank", "penny_rank"];

/** Tracking params api.scryfall.com decorates purchase/related URIs with; the bulk data has none. */
const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "referrer", "affiliate_id", "ref", "subId1"];

// ─── cases file shape ─────────────────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface DeviationSide {
	status: number;
	/** Dotted paths into the parsed body -> the value recorded there. */
	expect?: Record<string, Json>;
}

interface KnownDeviation {
	reason: string;
	ours: DeviationSide;
	scryfall: DeviationSide;
}

interface FieldDeviation {
	name: string;
	note: string;
	/** Path patterns: `.`-separated segments, `*` one segment, `**` any run of segments. */
	paths: string[];
	/** Recorded relationship between the two sides' values, asserted so the deviation cannot rot. */
	normalize?: "percent-decode" | "casefold-sorted";
	/**
	 * Exact case names this deviation is scoped to; absent means every case. Scoping keeps a
	 * layout-specific divergence (say, transform's hoisted top-level fields) from silently
	 * absorbing the same path going wrong on a case where the two sides DO agree today.
	 */
	cases?: string[];
}

interface CaseSpec {
	name: string;
	method: "GET" | "POST";
	path: string;
	body?: Json;
	/** Extra volatile patterns for this case, stripped from both sides. */
	volatile?: string[];
	/** Extra Scryfall-only-key patterns for this case. */
	scryfall_only_keys?: string[];
	known_deviation?: KnownDeviation;
	/** Free-text rationale for how this case is built. Documentation only; never read at runtime. */
	note?: string;
	/** Names the store capability this case waits on; skipped unless --include-pending. */
	pending?: string;
}

interface CasesFile {
	scryfall_only_keys: string[];
	scryfall_only_key_notes?: Record<string, string>;
	field_deviations: FieldDeviation[];
	cases: CaseSpec[];
}

// ─── flags ────────────────────────────────────────────────────────────────────

let origin = DEFAULT_ORIGIN;
let casesPath = join(repoRoot, "scripts/live-parity-cases.json");
let only: string | undefined;
let includePending = false;
let trustedKey: string | undefined = process.env[TRUSTED_KEY_ENV] || undefined;

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
		else if (arg === "--cases") casesPath = value();
		else if (arg === "--only") only = value();
		else if (arg === "--include-pending") includePending = true;
		else if (arg === "--key") trustedKey = value();
		else throw new Error(`unknown flag: ${arg}`);
	}
}

// A REMOTE origin with no key is refused BEFORE any case runs. The alternative — discovering it
// case by case — is what produced 68 identical `ours 429` failures that read as a catastrophic
// parity regression, so this exits with the fix rather than the symptom.
if (!trustedKey && !isLocalOrigin(origin)) {
	console.error(`live-parity: ${origin} enforces a per-IP rate limit, and no bypass key was given.`);
	console.error("");
	console.error(`  export ${TRUSTED_KEY_ENV}=<one of the Worker's TRUSTED_API_KEYS>   # then re-run`);
	console.error("  # or pass --key <k> for a one-off; or --origin http://localhost:8787 against a dev server");
	console.error("");
	console.error("Without it every case answers 429 and the run reports parity failures it did not measure.");
	process.exit(2);
}

// ─── polite Scryfall fetch with a per-day cache ───────────────────────────────

let lastScryfallAt = 0;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Fetched {
	status: number;
	body: string;
}

function cacheFileFor(method: string, path: string, body: string | undefined): string {
	const day = new Date().toISOString().slice(0, 10);
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`${method} ${path}\n${body ?? ""}`);
	const key = hasher.digest("hex").slice(0, 24);
	return join(CACHE_ROOT, day, `${key}.json`);
}

async function fetchScryfall(method: string, path: string, body: string | undefined): Promise<Fetched> {
	const cacheFile = cacheFileFor(method, path, body);
	if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8")) as Fetched;

	for (let attempt = 0; ; attempt++) {
		const wait = lastScryfallAt + MIN_SCRYFALL_GAP_MS - Date.now();
		if (wait > 0) await sleep(wait);
		lastScryfallAt = Date.now();
		const res = await fetch(`${SCRYFALL_ORIGIN}${path}`, {
			method,
			headers: {
				accept: "application/json",
				"user-agent": USER_AGENT,
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body,
		});
		if (res.status === 429 && attempt < 5) {
			const retryAfter = Number(res.headers.get("retry-after") ?? "") || 2;
			console.log(`         (429 from Scryfall; honoring Retry-After ${retryAfter}s)`);
			await res.arrayBuffer();
			await sleep(retryAfter * 1000);
			continue;
		}
		const fetched: Fetched = { status: res.status, body: await res.text() };
		mkdirSync(dirname(cacheFile), { recursive: true });
		writeFileSync(cacheFile, JSON.stringify(fetched));
		return fetched;
	}
}

async function fetchOurs(method: string, path: string, body: string | undefined): Promise<Fetched> {
	const res = await fetch(`${origin}${path}`, {
		method,
		headers: {
			accept: "application/json",
			"cache-control": "no-cache",
			// Ours only — api.scryfall.com never sees this header.
			...(trustedKey ? { [TRUSTED_KEY_HEADER]: trustedKey } : {}),
			...(body !== undefined ? { "content-type": "application/json" } : {}),
		},
		body,
	});
	// A 429 with a key present means the key is not in the Worker's list (or the list is unset),
	// and every remaining case would answer the same way. Stop on the first one and say which of
	// the two it is, rather than filling the report with parity failures that are really auth.
	if (res.status === 429) {
		await res.text();
		console.error("");
		console.error(`live-parity: ${origin} answered 429 on ${method} ${path}.`);
		console.error(
			trustedKey
				? `  ${TRUSTED_KEY_HEADER} was sent but not accepted — check the key is present in the Worker's TRUSTED_API_KEYS list.`
				: `  No ${TRUSTED_KEY_HEADER} was sent; export ${TRUSTED_KEY_ENV} and re-run.`,
		);
		console.error("  Aborting: the remaining cases would report rate limiting as parity failures.");
		process.exit(2);
	}
	return { status: res.status, body: await res.text() };
}

// ─── path patterns ────────────────────────────────────────────────────────────

/** "a.*.b" -> ["a","*","b"]; a bare key name means "this leaf anywhere". */
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

// ─── the reductions ───────────────────────────────────────────────────────────

function isObject(v: Json): v is { [key: string]: Json } {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Self-referential URIs carry OUR origin; rewrite them to Scryfall's so the values compare. */
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

/** Null every price and drop the `?<timestamp>` cache-buster from every image URI, both sides. */
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

/** Remove every key whose path matches a pattern — the volatile list, or the Scryfall-only ledger. */
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

/** Unwrap partner.tcgplayer.com redirects and drop tracking params — Scryfall's side only. */
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

/** Recursive key sort: the repo compares by upstream's key order, so order itself must not diff. */
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

// ─── structural diff ──────────────────────────────────────────────────────────

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

function getAt(v: Json, path: string[]): Json | undefined {
	let cur: Json = v;
	for (const seg of path) {
		if (Array.isArray(cur)) {
			const next = cur[Number(seg)];
			if (next === undefined) return undefined;
			cur = next;
		} else if (isObject(cur)) {
			const next = cur[seg];
			if (next === undefined) return undefined;
			cur = next;
		} else {
			return undefined;
		}
	}
	return cur;
}

function excerpt(v: Json | undefined): string {
	const text = v === undefined ? "(absent)" : stringifyScryfall(v);
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

// ─── field deviations ─────────────────────────────────────────────────────────

/**
 * The prefix of `path` (longest first) that a deviation pattern matches, or null. A deviation on
 * `**.keywords` must also cover a diff INSIDE the array (`keywords.0`), and the normalize check
 * then runs on the matched prefix — the whole array — not on the element.
 */
function deviationPrefix(deviation: FieldDeviation, path: string[]): string[] | null {
	const patterns = deviation.paths.map(compilePattern);
	for (let len = path.length; len >= 1; len--) {
		const prefix = path.slice(0, len);
		if (anyPatternMatches(patterns, prefix)) return prefix;
	}
	return null;
}

function safePercentDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** True when the two sides' values still stand in the deviation's recorded relationship. */
function normalizedEqual(kind: NonNullable<FieldDeviation["normalize"]>, scryfall: Json, ours: Json): boolean {
	if (kind === "percent-decode") {
		return (
			typeof scryfall === "string" &&
			typeof ours === "string" &&
			safePercentDecode(scryfall) === safePercentDecode(ours)
		);
	}
	// casefold-sorted: order-free, case-folded equality — string lists whose casing (not content)
	// is the recorded divergence.
	const fold = (v: Json): string =>
		Array.isArray(v) ? JSON.stringify(v.map((x) => String(x).toLowerCase()).sort()) : canonical(v).toLowerCase();
	return fold(scryfall) === fold(ours);
}

// ─── per-case verdicts ────────────────────────────────────────────────────────

type Verdict =
	| { kind: "pass" }
	| { kind: "pass-with-deviations"; names: string[] }
	| { kind: "known-deviation" }
	| { kind: "drift"; details: string[] }
	| { kind: "fail"; details: string[] };

function checkRecordedSide(label: string, side: DeviationSide, fetched: Fetched, problems: string[]): void {
	if (fetched.status !== side.status) problems.push(`${label}: recorded status ${side.status}, got ${fetched.status}`);
	if (!side.expect) return;
	let parsed: Json;
	try {
		parsed = JSON.parse(fetched.body) as Json;
	} catch {
		problems.push(`${label}: body is not JSON`);
		return;
	}
	for (const [dotted, expected] of Object.entries(side.expect)) {
		const actual = getAt(parsed, dotted.split("."));
		if (canonical(actual ?? null) !== canonical(expected))
			problems.push(`${label}: ${dotted} recorded ${excerpt(expected)}, got ${excerpt(actual)}`);
	}
}

async function runCase(spec: CaseSpec, file: CasesFile): Promise<Verdict> {
	const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
	const ours = await fetchOurs(spec.method, spec.path, body);
	const theirs = await fetchScryfall(spec.method, spec.path, body);

	// A KNOWN_DEVIATION case never byte-compares: the two sides are RECORDED to disagree, and each
	// is held to its own recording. A side that moved is drift, the distinct exit-2 category.
	if (spec.known_deviation) {
		const problems: string[] = [];
		checkRecordedSide("ours", spec.known_deviation.ours, ours, problems);
		checkRecordedSide("scryfall", spec.known_deviation.scryfall, theirs, problems);
		return problems.length === 0 ? { kind: "known-deviation" } : { kind: "drift", details: problems };
	}

	if (ours.status !== theirs.status)
		return { kind: "fail", details: [`status: scryfall ${theirs.status}, ours ${ours.status}`] };

	let scryfallBody: Json;
	let oursBody: Json;
	try {
		scryfallBody = JSON.parse(theirs.body) as Json;
		oursBody = JSON.parse(ours.body) as Json;
	} catch (err) {
		return { kind: "fail", details: [`a body is not JSON: ${String(err)}`] };
	}

	// Before the volatile reduction erases them: the shape of the values it is about to erase.
	const shapeProblems = checkVolatileShape(oursBody, scryfallBody, shapeTally);

	const volatilePatterns = [...VOLATILE_KEYS, ...(spec.volatile ?? [])].map(compilePattern);
	const ledgerPatterns = [...file.scryfall_only_keys, ...(spec.scryfall_only_keys ?? [])].map(compilePattern);

	const oursReduced = stripPatternKeys(stripVolatileSpecials(substituteOrigin(oursBody)), volatilePatterns);
	const scryfallReduced = stripAffiliateDecoration(
		stripPatternKeys(stripPatternKeys(stripVolatileSpecials(scryfallBody), volatilePatterns), ledgerPatterns),
	);

	if (canonical(scryfallReduced) === canonical(oursReduced))
		return shapeProblems.length > 0 ? { kind: "fail", details: shapeProblems } : { kind: "pass" };

	// Bytes differ. Classify every differing path: covered by a field deviation (green, named),
	// covered but off its recording (drift), or a plain failure.
	const diffs: Diff[] = [];
	collectDiffs(scryfallReduced, oursReduced, [], diffs);

	const firedDeviations = new Set<string>();
	const driftDetails: string[] = [];
	const failDetails: string[] = [];
	const normalizeChecked = new Set<string>();

	for (const diff of diffs) {
		let covered = false;
		for (const deviation of file.field_deviations) {
			if (deviation.cases && !deviation.cases.includes(spec.name)) continue;
			const prefix = deviationPrefix(deviation, diff.path);
			if (!prefix) continue;
			covered = true;
			firedDeviations.add(deviation.name);
			if (deviation.normalize) {
				const checkKey = `${deviation.name}@${prefix.join(".")}`;
				if (!normalizeChecked.has(checkKey)) {
					normalizeChecked.add(checkKey);
					const sfValue = getAt(scryfallReduced, prefix) ?? null;
					const usValue = getAt(oursReduced, prefix) ?? null;
					if (!normalizedEqual(deviation.normalize, sfValue, usValue)) {
						driftDetails.push(
							`${deviation.name} at ${prefix.join(".")}: sides no longer stand in the recorded ` +
								`${deviation.normalize} relationship — scryfall ${excerpt(sfValue)}, ours ${excerpt(usValue)}`,
						);
					}
				}
			}
			break;
		}
		if (covered) continue;
		const at = diff.path.join(".") || "(root)";
		if (diff.kind === "missing-ours") {
			failDetails.push(
				`${at}: Scryfall sends a key the mirror does not (${excerpt(diff.scryfall)}). If upstream #912 ` +
					`deliberately has no such column, ledger it: add "${diff.path.map((s) => (/^\d+$/.test(s) ? "*" : s)).join(".")}" ` +
					`to scryfall_only_keys in ${casesPath} with a note; otherwise the mirror is missing a field.`,
			);
		} else if (diff.kind === "missing-scryfall") {
			failDetails.push(`${at}: the mirror sends a key Scryfall does not: ${excerpt(diff.ours)}`);
		} else if (diff.kind === "array-length") {
			failDetails.push(`${at}: array length differs — scryfall ${excerpt(diff.scryfall)}, ours ${excerpt(diff.ours)}`);
		} else {
			failDetails.push(`${at}: scryfall ${excerpt(diff.scryfall)}, ours ${excerpt(diff.ours)}`);
		}
	}

	// A failing case still reports any drift it found — hiding it would cost a fix-verify round.
	if (failDetails.length > 0 || shapeProblems.length > 0)
		return { kind: "fail", details: [...shapeProblems, ...failDetails, ...driftDetails] };
	if (driftDetails.length > 0) return { kind: "drift", details: driftDetails };
	return { kind: "pass-with-deviations", names: [...firedDeviations].sort() };
}

// ─── main ─────────────────────────────────────────────────────────────────────

const file = JSON.parse(readFileSync(casesPath, "utf8")) as CasesFile;

const selected = file.cases.filter((c) => !only || c.name.includes(only));
const pendingSkipped: CaseSpec[] = [];

let passes = 0;
let knownDeviations = 0;
let drifts = 0;
let failures = 0;

/** Accumulated across every case; the run-level half of the volatile-shape guard. */
const shapeTally = newVolatileShapeTally();

console.log(`live-parity: ${origin}  vs  ${SCRYFALL_ORIGIN}`);
console.log(`cases: ${casesPath} (${selected.length} selected${only ? ` by --only ${only}` : ""})`);
console.log(
	`auth:  ${trustedKey ? `${TRUSTED_KEY_HEADER} sent (per-IP limiter bypassed)` : "none — local origin, limiter not enforced"}`,
);

for (const spec of selected) {
	if (spec.pending && !includePending) {
		pendingSkipped.push(spec);
		continue;
	}
	let verdict: Verdict;
	try {
		verdict = await runCase(spec, file);
	} catch (err) {
		verdict = { kind: "fail", details: [String(err)] };
	}
	switch (verdict.kind) {
		case "pass":
			passes++;
			console.log(`    ok   ${spec.name}`);
			break;
		case "pass-with-deviations":
			passes++;
			console.log(`    ok   ${spec.name} (deviations: ${verdict.names.join(", ")})`);
			break;
		case "known-deviation":
			knownDeviations++;
			console.log(`    ok   ${spec.name} (KNOWN_DEVIATION, both sides as recorded)`);
			break;
		case "drift":
			drifts++;
			console.log(`    DRIFT ${spec.name}`);
			for (const d of verdict.details) console.log(`         ${d}`);
			break;
		case "fail":
			failures++;
			console.log(`    FAIL ${spec.name}`);
			for (const d of verdict.details) console.log(`         ${d}`);
			break;
	}
}

if (pendingSkipped.length > 0) {
	console.log(`\nskipped ${pendingSkipped.length} pending case(s) (run with --include-pending):`);
	const byTag = new Map<string, string[]>();
	for (const spec of pendingSkipped) {
		const tag = spec.pending ?? "";
		byTag.set(tag, [...(byTag.get(tag) ?? []), spec.name]);
	}
	for (const [tag, names] of byTag) {
		console.log(`    pending: ${tag}`);
		for (const name of names) console.log(`        ${name}`);
	}
}

// The run-level half of the volatile-shape guard: a price key (or the cache-buster) that no case
// saw a value for on our side while Scryfall served it broadly. Counted as a failure of its own,
// because no single case can observe it.
const runShapeProblems = volatileShapeRunProblems(shapeTally);
console.log(`\n${volatileShapeSummary(shapeTally)}`);
for (const problem of runShapeProblems) console.log(`    FAIL ${problem}`);
failures += runShapeProblems.length;

console.log(
	`\n${passes} passed, ${knownDeviations} known-deviation, ${drifts} drifted, ${failures} failed` +
		`${pendingSkipped.length > 0 ? `, ${pendingSkipped.length} pending-skipped` : ""}`,
);

if (failures > 0) process.exit(1);
if (drifts > 0) process.exit(2);
