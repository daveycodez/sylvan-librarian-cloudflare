// The production canary: a dozen requests that say whether the deployed mirror is ANSWERING like
// the corpus it is supposed to hold — not merely that it is up.
//
// WHY. On 2026-11-19 an unattended import published a store with no oracle tags and every `otag:`
// search answered 404 for four and a half hours. `/search?q=lightning+bolt` — the one thing the
// deploy's smoke test asked — worked throughout, and nothing ran after an IMPORT at all: the
// imports are the Worker's own, twice a day, with no commit to hang a check on. This script is
// that check. It runs after every deploy (ci.yml `smoke`) and on a schedule (canary.yml), where a
// red run is the notification.
//
//   bun scripts/canary.ts [--stale] [origin …]   (default: both accounts' workers.dev hosts)
//
// WHAT IT ASKS, per origin, each with a fresh query-string nonce so the edge cache cannot answer:
//   - searches whose totals must clear a floor (about two thirds of today's) — tags of both
//     kinds, a type, a name, a foreign language, an exact name;
//   - the same tag searches against api.scryfall.com: the mirror must hold at least 90% of
//     Scryfall's total. One-sided on purpose (Scryfall is ahead of the mirror by up to a refresh),
//     and skipped, not failed, when Scryfall itself does not answer;
//   - the KV-only routes: a set, a catalog, a card by exact name and its rulings;
//   - the store's age from `x-sylvan-store`: older than MAX_STORE_AGE_HOURS means imports are
//     being skipped or failing — the mirror is serving, and going stale. Printed always; a
//     failure only with `--stale`.
//
// A check that fails is asked again (three tries, 20 s apart) before it counts: one bad request is
// not an outage. Exit 1 with one `::error::` line per failed check.
//
// No imports from the repo and no dependencies: it runs on a bare runner with bun and nothing else.

export {}; // a module, so the checks below may await at the top level

const DEFAULT_ORIGINS = [
	"https://sylvan-librarian.deckgen.workers.dev",
	"https://sylvan-librarian.daveycodez.workers.dev",
];
const SCRYFALL = "https://api.scryfall.com";
const USER_AGENT = "sylvan-canary/1.0";
/**
 * Two missed refreshes and a margin: Scryfall refreshes every twelve hours. The age is always
 * printed; it FAILS the run only with `--stale`, which canary.yml passes four times a day — a store
 * going stale is a slow condition, and a red run every half hour for it would be forty-eight mails
 * a day about one thing.
 */
const MAX_STORE_AGE_HOURS = 30;
const FAIL_WHEN_STALE = process.argv.includes("--stale");
const TRIES = 3;
const RETRY_MS = 20_000;
/** The mirror must hold this share of Scryfall's total for a parity search. */
const PARITY_RATIO = 0.9;

/** `min` is about two thirds of the total on 2026-11-20 (in the comment); `parity` also asks Scryfall. */
const SEARCHES: { q: string; min: number; parity?: boolean }[] = [
	{ q: "otag:ramp", min: 1_500, parity: true }, // 2,356
	{ q: "otag:removal", min: 4_000, parity: true }, // 6,492
	{ q: "otag:draw", min: 3_000, parity: true }, // 4,343
	{ q: "atag:dragon", min: 700, parity: true }, // 1,153
	{ q: "t:goblin c:r", min: 350, parity: true }, // 495
	{ q: "lang:ja t:goblin", min: 300 }, // 509
	{ q: "lightning bolt", min: 1 }, // 2
	{ q: '!"Lightning Bolt"', min: 1 }, // 2
];

type Json = Record<string, unknown>;
const nonce = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url: string): Promise<{ status: number; body: Json | null; headers: Headers }> {
	const res = await fetch(url, {
		headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
		signal: AbortSignal.timeout(30_000),
	});
	let body: Json | null = null;
	try {
		body = (await res.json()) as Json;
	} catch {
		body = null;
	}
	return { status: res.status, body, headers: res.headers };
}

/** A search's `total_cards` (0 for Scryfall's 404 "no cards"), or null when the answer is unusable. */
async function searchTotal(
	origin: string,
	q: string,
	bust: boolean,
): Promise<{ total: number | null; headers: Headers }> {
	const params = new URLSearchParams({ q });
	if (bust) params.set("_canary", nonce());
	const { status, body, headers } = await getJson(`${origin}/cards/search?${params}`);
	if (status === 404 && body?.code === "not_found") return { total: 0, headers };
	const total = status === 200 && typeof body?.total_cards === "number" ? body.total_cards : null;
	return { total, headers };
}

/** Run `check` until it passes or the tries run out; the last failure is the one reported. */
async function settled(check: () => Promise<string | null>): Promise<string | null> {
	let problem: string | null = null;
	for (let attempt = 1; attempt <= TRIES; attempt++) {
		try {
			problem = await check();
		} catch (err) {
			problem = `request failed: ${err}`;
		}
		if (problem === null) return null;
		if (attempt < TRIES) await pause(RETRY_MS);
	}
	return problem;
}

const scryfallTotals = new Map<string, number | null>();
/** Scryfall's own total for `q`, asked once per run; null when Scryfall did not answer usably. */
async function scryfallTotal(q: string): Promise<number | null> {
	if (scryfallTotals.has(q)) return scryfallTotals.get(q) ?? null;
	let total: number | null = null;
	try {
		total = (await searchTotal(SCRYFALL, q, false)).total;
	} catch {
		total = null;
	}
	scryfallTotals.set(q, total);
	await pause(500); // Scryfall asks for a pause between requests
	return total;
}

async function checkOrigin(origin: string): Promise<string[]> {
	const failures: string[] = [];
	const fail = (what: string, problem: string | null) => {
		if (problem !== null) failures.push(`${origin}: ${what} — ${problem}`);
		console.log(`  ${problem === null ? "ok  " : "FAIL"} ${what}${problem === null ? "" : ` — ${problem}`}`);
	};
	let storeBuiltAt: number | null = null;

	for (const { q, min, parity } of SEARCHES) {
		const theirs = parity ? await scryfallTotal(q) : null;
		let seen = "";
		const problem = await settled(async () => {
			const { total, headers } = await searchTotal(origin, q, true);
			const store = Number(headers.get("x-sylvan-store") ?? Number.NaN);
			if (Number.isFinite(store) && store > 0) storeBuiltAt = store;
			if (total === null) return "no usable answer";
			seen = `${total}${theirs === null ? "" : ` (Scryfall ${theirs})`}`;
			if (total < min) return `${total} cards, under the floor of ${min}`;
			if (theirs !== null && theirs >= 20 && total < PARITY_RATIO * theirs) {
				return `${total} cards where Scryfall answers ${theirs}`;
			}
			return null;
		});
		fail(`search ${q}${problem === null ? `: ${seen}` : ""}`, problem);
	}

	fail(
		"/sets/lea",
		await settled(async () => {
			const { status, body } = await getJson(`${origin}/sets/lea?_canary=${nonce()}`);
			return status === 200 && body?.code === "lea" ? null : `status ${status}`;
		}),
	);
	fail(
		"/catalog/creature-types",
		await settled(async () => {
			const { status, body } = await getJson(`${origin}/catalog/creature-types?_canary=${nonce()}`);
			const count = Array.isArray(body?.data) ? body.data.length : 0;
			return status === 200 && count >= 250 ? null : `status ${status}, ${count} types`;
		}),
	);
	fail(
		"/cards/named?exact= and its rulings",
		await settled(async () => {
			const named = await getJson(`${origin}/cards/named?exact=Counterspell&_canary=${nonce()}`);
			const id = typeof named.body?.id === "string" ? named.body.id : null;
			if (named.status !== 200 || id === null) return `named answered ${named.status}`;
			const rulings = await getJson(`${origin}/cards/${id}/rulings?_canary=${nonce()}`);
			return rulings.status === 200 && Array.isArray(rulings.body?.data) ? null : `rulings answered ${rulings.status}`;
		}),
	);

	// The store's age. An origin on a build before the header says nothing, which is not a failure.
	if (storeBuiltAt === null) {
		console.log("  --   store age: no x-sylvan-store header on this build");
	} else {
		const hours = (Date.now() / 1000 - storeBuiltAt) / 3600;
		const stale = hours > MAX_STORE_AGE_HOURS;
		const what = `store built ${new Date(storeBuiltAt * 1000).toISOString()} (${hours.toFixed(1)}h ago)`;
		const problem = `older than ${MAX_STORE_AGE_HOURS}h: imports are being skipped or failing — look for the Worker's "Import stopped" log line`;
		if (stale && !FAIL_WHEN_STALE) console.log(`  warn ${what} — ${problem}`);
		else fail(what, stale ? problem : null);
	}
	return failures;
}

const origins = process.argv.slice(2).filter((arg) => /^https?:\/\//.test(arg));
const failures: string[] = [];
for (const origin of origins.length > 0 ? origins : DEFAULT_ORIGINS) {
	console.log(origin);
	failures.push(...(await checkOrigin(origin)));
}
if (failures.length > 0) {
	for (const failure of failures) console.log(`::error::${failure}`);
	process.exit(1);
}
console.log("canary: every check passed");
