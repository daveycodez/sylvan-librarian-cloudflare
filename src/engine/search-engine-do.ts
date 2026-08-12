// Per-colo warm-engine Durable Object — the only thing that serves engine
// queries. Worker isolates parse and RPC here; they never load the store.
// One DO per colo (engine-LAX, engine-SEA, ...), created in the colo that
// first names it, so sharding tracks the traffic distribution. No alarms, no
// standing cost: idle colos evict their DO and cost nothing (scale to zero).
//
// The DO keeps NO local copy of the store. It used to persist all ~70MB into
// its own SQLite so wakes avoided the origin, which cost a 70MB write burst on
// first boot (blocking live responses behind the output gate until the writes
// were trickled), 70MB of the 5GB DO storage pool per colo — which is what
// forced free-plan sharding down to one shard — and ~39 metered row reads on
// every wake. KV replaced all of it: a wake is ~4 KV reads of immutable,
// colo-cached chunks, so the local copy earned nothing it cost.

import { DurableObject } from "cloudflare:workers";
import { firstToSucceed } from "./first-to-succeed";
import { compatAttached, getEngine, tryGetLoadedEngine } from "./store";
import type {
	Engine,
	EngineSearchOptions,
	EngineSearchResult,
	EngineSerializedResult,
	Env,
	ResultShape,
	ScryfallFuzzyResult,
} from "./types";
import { EngineUnavailableError } from "./types";

/**
 * `/cards/*` replies, wrapped so `instrumented` has an object to spread telemetry over. A bare
 * `null` card — the genuine miss that becomes a Scryfall 404 — cannot carry riders on its own.
 */
interface ScryfallCardReply {
	card: Record<string, unknown> | null;
}
interface ScryfallCardsReply {
	cards: Record<string, unknown>[];
}
interface ScryfallMaybeCardsReply {
	cards: (Record<string, unknown> | null)[];
}
interface ScryfallNamesReply {
	names: string[];
}

/** Shard-controller riders every search RPC carries back (see RemoteEngine). */
interface SearchTelemetry {
	acquireMs: number;
	load: number;
	rate: number;
	relayed: boolean;
	/** Widest fan-out any caller has reported lately — the rendezvous. */
	shards: number;
}

/**
 * How long the announced width survives without a caller re-reporting it.
 *
 * The announcement has to be a DECAYING max, not a running one. A plain max
 * would ratchet: the controller's contraction step lowers an isolate's width,
 * the isolate would immediately re-adopt the stale higher value from here, and
 * scale-in could never happen. With a TTL, a width nobody is still reporting
 * ages out and the announcement follows the callers back down. Sized to match
 * CONTRACT_COOLDOWN_MS so decay and contraction step at the same pace.
 */
const WIDTH_TTL_MS = 60_000;

/** One-second buckets behind the arrival-rate meter; also its window in
 * seconds, since each bucket holds exactly one. */
const RATE_BUCKETS = 10;

/**
 * RPC error marker: workerd propagates only Error#message across RPC, so the
 * EngineUnavailableError contract (routes turn it into upstream's exact 503 /
 * the bootstrap page) is encoded into the message and decoded by RemoteEngine.
 */
export const ENGINE_UNAVAILABLE_MARKER = "__ENGINE_UNAVAILABLE__";

function rethrowForRpc(err: unknown): never {
	if (err instanceof EngineUnavailableError) {
		throw new Error(`${ENGINE_UNAVAILABLE_MARKER}:${err.message}`);
	}
	throw err;
}

export class SearchEngine extends DurableObject<Env> {
	/** Searches already executing here; snapshotted per request as the queue-
	 * depth (`load`) signal. */
	private inFlightSearches = 0;
	/** Arrivals per second, for the request-RATE the shard controller gates
	 * expansion on. Rate is the cause-side measurement: latency rises for
	 * reasons sharding cannot fix (KV slowness, network, a noisy neighbour),
	 * and adding shards to those only makes them worse, because every new
	 * shard cold-loads ~70MB. Load without slowness means we are coping;
	 * slowness without load means the problem is elsewhere. Real saturation
	 * always shows both.
	 *
	 * Ten one-second buckets in a ring, indexed by epoch second, each carrying
	 * the second it belongs to so a stale one is skipped rather than cleared.
	 * This replaced an array of arrival timestamps that had two faults: it was
	 * capped at 4096 entries over a 10s window, so the reported rate SATURATED
	 * at 409.6/s — the production expansion log reads "at 410/s", which is the
	 * cap and not the traffic — and it re-filtered the whole array into a fresh
	 * allocation on every single search, putting an O(n) copy on the hot path
	 * of a single-threaded object precisely when n was largest. */
	private readonly rateCounts = new Uint32Array(RATE_BUCKETS);
	private readonly rateSeconds = new Float64Array(RATE_BUCKETS);

	/**
	 * The fan-out rendezvous: widest width any caller has reported, with a TTL.
	 *
	 * activeShards is per-isolate state, and every new isolate starts at 1 — so
	 * without somewhere to meet, an isolate that has not expanded sends all its
	 * traffic to shard 0 and never learns better. Measured on production
	 * 2026-08-09: four shards open, split stuck at ~73/17/10/5 across every
	 * stage of a ramp, ~64% of isolates never expanding. This DO is the meeting
	 * point, because the isolates that need convincing are exactly the ones
	 * sending everything here.
	 */
	private announcedShards = 1;
	private announcedAt = 0;

	/** Fold a caller's width in and hand back the current announcement. */
	private rendezvous(reported: number, now: number): number {
		const width = Number.isFinite(reported) && reported >= 1 ? Math.floor(reported) : 1;
		// Refresh on any report at or above the announcement — otherwise a
		// stream of lower reports would keep a stale higher value alive forever
		// and defeat the TTL.
		if (width >= this.announcedShards || now - this.announcedAt > WIDTH_TTL_MS) {
			this.announcedShards = width;
			this.announcedAt = now;
		}
		return this.announcedShards;
	}

	/** Searches per second over the trailing window. O(RATE_BUCKETS), no
	 * allocation, and no ceiling short of 2^32 arrivals in one second. */
	private searchRate(now: number): number {
		const second = Math.floor(now / 1000);
		const slot = ((second % RATE_BUCKETS) + RATE_BUCKETS) % RATE_BUCKETS;
		if (this.rateSeconds[slot] !== second) {
			this.rateSeconds[slot] = second;
			this.rateCounts[slot] = 0;
		}
		this.rateCounts[slot] = (this.rateCounts[slot] as number) + 1;
		let total = 0;
		for (let i = 0; i < RATE_BUCKETS; i++) {
			if (second - (this.rateSeconds[i] as number) < RATE_BUCKETS) total += this.rateCounts[i] as number;
		}
		return total / RATE_BUCKETS;
	}

	// ── RPC surface ────────────────────────────────────────────────────────────
	//
	// Every method takes an optional fallbackHint: when this DO is COLD and a
	// hint is present, it relays the call to the region's DO (engine-<hint>)
	// and warms itself in the background — the caller never waits on a load.
	// The relay passes NO hint, so a cold regional DO answers after its own
	// load rather than relaying further (recursion depth 1 by construction).

	async search(
		opts: EngineSearchOptions,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<EngineSearchResult & SearchTelemetry> {
		if (this.shouldRelay(fallbackHint)) {
			return this.relay(
				fallbackHint,
				(region) => region.search(opts),
				(engine) => engine.search(opts),
				reportedShards,
			);
		}
		return this.instrumented(reportedShards, (engine) => engine.search(opts));
	}

	/**
	 * The API path: identical routing and telemetry, but the cards come back
	 * already encoded, so no card ever becomes a JS object in the isolate that
	 * serves the request. See EngineSerializedResult.
	 */
	async searchSerialized(
		opts: EngineSearchOptions,
		shape: ResultShape,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<EngineSerializedResult & SearchTelemetry> {
		if (this.shouldRelay(fallbackHint)) {
			return this.relay(
				fallbackHint,
				(region) => region.searchSerialized(opts, shape),
				(engine) => engine.searchSerialized(opts, shape),
				reportedShards,
			);
		}
		return this.instrumented(reportedShards, (engine) => engine.searchSerialized(opts, shape));
	}

	/**
	 * Answer from whichever is ready first: the region's already-warm store, or
	 * this colo's own load.
	 *
	 * It used to relay unconditionally and warm in the background. That is right
	 * only while the region is WARM. Every deploy resets every Durable Object,
	 * so the first request in each colo found the region cold too — and then
	 * relaying was strictly worse than doing nothing clever: the region loaded
	 * the whole ~70MB store just to answer one request, this colo loaded it as
	 * well, and the user waited for the slower of the two plus a cross-colo hop.
	 * Measured on one such request: two loads, 865ms + 465ms of DO CPU, 2.4s of
	 * wall, for a page that needed twelve random cards.
	 *
	 * Racing fixes that without giving up the case the relay exists for. The
	 * local attempt is not extra work — this DO has to end up warm regardless,
	 * and `instrumented` is what starts that load, so the race simply keeps its
	 * answer instead of discarding it. A warm region still wins on a
	 * cross-colo hop; a cold region no longer costs the user anything.
	 *
	 * Telemetry stays honest either way: a relayed answer carries the REGION's
	 * acquireMs/load/rate and is flagged `relayed` so the shard controller drops
	 * it, while a locally-won answer carries this colo's own.
	 */
	private async relay<T extends object>(
		hint: DurableObjectLocationHint,
		viaRegion: (region: SearchEngine) => Promise<T & SearchTelemetry>,
		locally: (engine: Engine) => Promise<T>,
		reportedShards?: number,
	): Promise<T & SearchTelemetry> {
		const started = Date.now();
		const local = this.instrumented(reportedShards, locally);
		const relayed = viaRegion(this.regionStub(hint)).then((result) => ({ ...result, relayed: true }));
		const answer = await firstToSucceed<T & SearchTelemetry>(local, relayed);
		console.log(
			`Cold colo answered ${answer.relayed ? `via engine-${hint}` : "from its own load"} in ${Date.now() - started}ms`,
		);
		return answer;
	}

	/** Run a search against the local engine, carrying the autoscaler's signals. */
	private async instrumented<T extends object>(
		reportedShards: number | undefined,
		run: (engine: Engine) => Promise<T>,
	): Promise<T & SearchTelemetry> {
		const now = Date.now();
		const load = this.inFlightSearches;
		const rate = this.searchRate(now);
		const shards = this.rendezvous(reportedShards ?? 1, now);
		this.inFlightSearches += 1;
		try {
			// Time the engine acquisition (the KV load, when there is one) for
			// the calling isolate's cold-path breakdown. Date.now() only advances
			// across I/O in Workers, which is what a load spends. Warm calls
			// report ~0.
			const acquireStart = Date.now();
			const engine = await this.engine();
			const acquireMs = Date.now() - acquireStart;
			try {
				return { ...(await run(engine)), acquireMs, load, rate, relayed: false, shards };
			} catch (err) {
				rethrowForRpc(err);
			}
		} finally {
			this.inFlightSearches -= 1;
		}
	}

	/**
	 * Race the region against this colo's own attempt, and SAY WHICH WON.
	 *
	 * The winner is the whole point of the race and it is not inferable after
	 * the fact — the load logs look identical either way, because the local
	 * attempt runs regardless. Without this line "did the relay help?" can only
	 * be answered by inference, which is how a day got lost.
	 *
	 * search/searchSerialized get the same line from relay(), which can read the
	 * winner off the telemetry it already carries.
	 */
	private async raceRegion<T>(
		hint: DurableObjectLocationHint,
		what: string,
		locally: Promise<T>,
		viaRegion: Promise<T>,
	): Promise<T> {
		const started = Date.now();
		const won = await firstToSucceed(
			locally.then((value) => ({ value, from: "its own load" })),
			viaRegion.then((value) => ({ value, from: `engine-${hint}` })),
		);
		console.log(`Cold colo answered ${what} from ${won.from} in ${Date.now() - started}ms`);
		return won.value;
	}

	/** Both catalogs in one RPC (get_catalog needs both). */
	async catalog(
		fallbackHint?: DurableObjectLocationHint,
	): Promise<{ types: Record<string, number>; keywords: Record<string, number> }> {
		const local = async () => {
			const engine = await this.engine();
			return { types: await engine.commonCardTypes(), keywords: await engine.commonCardKeywords() };
		};
		if (this.shouldRelay(fallbackHint)) {
			// See relay(): the local attempt IS the warm, so racing costs nothing
			// and stops a cold region from making the caller wait for its load.
			return this.raceRegion(fallbackHint, "catalog", local(), this.regionStub(fallbackHint).catalog());
		}
		return local();
	}

	async samplePreferred(
		numCards: number,
		fields: string[],
		fallbackHint?: DurableObjectLocationHint,
	): Promise<Record<string, unknown>[]> {
		const local = async () => (await this.engine()).samplePreferred(numCards, fields);
		if (this.shouldRelay(fallbackHint)) {
			return this.raceRegion(
				fallbackHint,
				"samplePreferred",
				local(),
				this.regionStub(fallbackHint).samplePreferred(numCards, fields),
			);
		}
		return local();
	}

	/**
	 * Instrumented like search(), and for the reason search() already was: this
	 * is the most expensive invocation in the deployment (~200ms of CPU against
	 * 1-2ms warm) and working out WHY took hours of inference, because search
	 * reports whether it had to acquire its engine and this did not.
	 *
	 * `warm` is the datum, and it needs no clock: whether this isolate already
	 * held the store before acquiring. An expensive call with warm=true would
	 * rule out the store load outright — which is the answer nothing else here
	 * can give, since the load's own log line is emitted by another module and
	 * cannot be correlated per invocation.
	 *
	 * `acquireMs` measures I/O only. Workers freeze the clock during synchronous
	 * execution, so a 0 beside a large cpuTime is itself the finding: the time
	 * went to compute, not to KV.
	 *
	 * Logged only when it actually acquired, matching RemoteEngine.searchRpc —
	 * a warm call is the boring case and says nothing worth a log line.
	 */
	async samplePreferredSerialized(
		numCards: number,
		fields: string[],
		shape: ResultShape,
		fallbackHint?: DurableObjectLocationHint,
	): Promise<EngineSerializedResult> {
		if (this.shouldRelay(fallbackHint)) {
			return this.raceRegion(
				fallbackHint,
				"samplePreferred",
				this.localSample(numCards, fields, shape),
				this.regionStub(fallbackHint).samplePreferredSerialized(numCards, fields, shape),
			);
		}
		return this.localSample(numCards, fields, shape);
	}

	/** samplePreferredSerialized against THIS colo's engine, loading if needed. */
	private async localSample(numCards: number, fields: string[], shape: ResultShape): Promise<EngineSerializedResult> {
		const warm = tryGetLoadedEngine() !== null;
		const acquireStart = Date.now();
		const engine = await this.engine();
		const acquireMs = Date.now() - acquireStart;
		const result = await engine.samplePreferredSerialized(numCards, fields, shape);
		if (!warm) {
			console.log(`samplePreferred acquired its engine in ${acquireMs}ms (cold isolate) for n=${numCards}`);
		}
		return result;
	}

	// ── The Scryfall-compatible /cards/* surface ────────────────────────────────
	//
	// Routed EXACTLY like search/searchSerialized: same relay-race on a cold colo, same
	// `instrumented` telemetry, same shard rendezvous. That is not symmetry for its own sake —
	// mtg-seeker points at `/cards/*`, so this is the traffic the deployment actually has to scale
	// under. Bypassing `instrumented` would leave the shard controller reading only `/search`
	// depth and rate, and it would decline to open a shard while `/cards/*` saturated the one it
	// had.
	//
	// Every result is wrapped in an object because `instrumented` spreads its telemetry over the
	// return value, and a bare `null` (a genuine card miss) has nothing to spread onto.
	// RemoteEngine unwraps on the other side, so the Engine interface keeps the plain shapes.

	async scryfallSearch(
		opts: EngineSearchOptions,
		baseUrl: string,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<EngineSerializedResult & SearchTelemetry> {
		return this.routeScryfall(
			fallbackHint,
			reportedShards,
			(region) => region.scryfallSearch(opts, baseUrl),
			(engine) => engine.scryfallSearch(opts, baseUrl),
		);
	}

	async scryfallCardById(
		scryfallId: string,
		baseUrl: string,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<ScryfallCardReply & SearchTelemetry> {
		return this.routeScryfall(
			fallbackHint,
			reportedShards,
			(region) => region.scryfallCardById(scryfallId, baseUrl),
			async (engine) => ({ card: await engine.scryfallCardById(scryfallId, baseUrl) }),
		);
	}

	async scryfallCardsByIds(
		scryfallIds: string[],
		baseUrl: string,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<ScryfallCardsReply & SearchTelemetry> {
		return this.routeScryfall(
			fallbackHint,
			reportedShards,
			(region) => region.scryfallCardsByIds(scryfallIds, baseUrl),
			async (engine) => ({ cards: await engine.scryfallCardsByIds(scryfallIds, baseUrl) }),
		);
	}

	async scryfallCardByOracleId(
		oracleId: string,
		baseUrl: string,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<ScryfallCardReply & SearchTelemetry> {
		return this.routeScryfall(
			fallbackHint,
			reportedShards,
			(region) => region.scryfallCardByOracleId(oracleId, baseUrl),
			async (engine) => ({ card: await engine.scryfallCardByOracleId(oracleId, baseUrl) }),
		);
	}

	async scryfallCardByExternalId(
		namespace: string,
		externalId: number,
		baseUrl: string,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<ScryfallCardReply & SearchTelemetry> {
		return this.routeScryfall(
			fallbackHint,
			reportedShards,
			(region) => region.scryfallCardByExternalId(namespace, externalId, baseUrl),
			async (engine) => ({ card: await engine.scryfallCardByExternalId(namespace, externalId, baseUrl) }),
		);
	}

	async scryfallFuzzyName(
		name: string,
		baseUrl: string,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<ScryfallFuzzyResult & SearchTelemetry> {
		return this.routeScryfall(
			fallbackHint,
			reportedShards,
			(region) => region.scryfallFuzzyName(name, baseUrl),
			(engine) => engine.scryfallFuzzyName(name, baseUrl),
		);
	}

	async scryfallAutocomplete(
		prefix: string,
		limit: number,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<ScryfallNamesReply & SearchTelemetry> {
		return this.routeScryfall(
			fallbackHint,
			reportedShards,
			(region) => region.scryfallAutocomplete(prefix, limit),
			async (engine) => ({ names: await engine.scryfallAutocomplete(prefix, limit) }),
		);
	}

	async scryfallExactName(
		folded: string,
		setCode: string,
		baseUrl: string,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<ScryfallCardReply & SearchTelemetry> {
		return this.routeScryfall(
			fallbackHint,
			reportedShards,
			(region) => region.scryfallExactName(folded, setCode, baseUrl),
			async (engine) => ({ card: await engine.scryfallExactName(folded, setCode, baseUrl) }),
		);
	}

	async scryfallCardByIllustrationId(
		illustrationId: string,
		baseUrl: string,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<ScryfallCardReply & SearchTelemetry> {
		return this.routeScryfall(
			fallbackHint,
			reportedShards,
			(region) => region.scryfallCardByIllustrationId(illustrationId, baseUrl),
			async (engine) => ({ card: await engine.scryfallCardByIllustrationId(illustrationId, baseUrl) }),
		);
	}

	async scryfallNamesContaining(
		words: string[],
		setCode: string,
		limit: number,
		baseUrl: string,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<ScryfallCardsReply & SearchTelemetry> {
		return this.routeScryfall(
			fallbackHint,
			reportedShards,
			(region) => region.scryfallNamesContaining(words, setCode, limit, baseUrl),
			async (engine) => ({ cards: await engine.scryfallNamesContaining(words, setCode, limit, baseUrl) }),
		);
	}

	async scryfallFirstOfEach(
		filterTreeJsons: string[],
		baseUrl: string,
		fallbackHint?: DurableObjectLocationHint,
		reportedShards?: number,
	): Promise<ScryfallMaybeCardsReply & SearchTelemetry> {
		return this.routeScryfall(
			fallbackHint,
			reportedShards,
			(region) => region.scryfallFirstOfEach(filterTreeJsons, baseUrl),
			async (engine) => ({ cards: await engine.scryfallFirstOfEach(filterTreeJsons, baseUrl) }),
		);
	}

	/** relay-or-instrument, the one shape every `/cards/*` entry point above uses. */
	private routeScryfall<T extends object>(
		fallbackHint: DurableObjectLocationHint | undefined,
		reportedShards: number | undefined,
		viaRegion: (region: SearchEngine) => Promise<T & SearchTelemetry>,
		locally: (engine: Engine) => Promise<T>,
	): Promise<T & SearchTelemetry> {
		if (this.shouldRelayScryfall(fallbackHint)) {
			return this.relay(fallbackHint, viaRegion, locally, reportedShards);
		}
		return this.instrumented(reportedShards, locally);
	}

	async size(fallbackHint?: DurableObjectLocationHint): Promise<number> {
		if (this.shouldRelay(fallbackHint)) {
			this.warmInBackground();
			return this.regionStub(fallbackHint).size();
		}
		const engine = await this.engine();
		return engine.size();
	}

	// ── Cold relay ─────────────────────────────────────────────────────────────

	/** Cold (no engine in this isolate) and permitted to relay. */
	private shouldRelay(hint?: DurableObjectLocationHint): hint is DurableObjectLocationHint {
		return hint !== undefined && tryGetLoadedEngine() === null;
	}

	/**
	 * The same question for a `/cards/*` query, which needs the residue archive as well.
	 *
	 * A DO can be fully warm for `/search` and still ~250-350ms of CPU away from a card object,
	 * because the residue is attached only on first `/cards/*` use — deliberately, so a
	 * search-only colo never carries its ~11.8MB. `shouldRelay` asked only about the store, so
	 * that attach was NOT hidden by the relay the store's own cold start has always used: the
	 * first card request to reach a warm colo paid all of it, in front of the user.
	 *
	 * Relaying makes it a race instead. The regional DO answers from its own attached archive
	 * while this one attaches in the background, and `firstToSucceed` takes whichever lands first
	 * — so the attach costs the request nothing it was not already spending on the round trip.
	 */
	private shouldRelayScryfall(hint?: DurableObjectLocationHint): hint is DurableObjectLocationHint {
		return hint !== undefined && (tryGetLoadedEngine() === null || !compatAttached());
	}

	/** The regional fallback engine's stub, typed like RemoteEngine's. */
	private regionStub(hint: DurableObjectLocationHint) {
		return this.env.SEARCH_ENGINE.get(this.env.SEARCH_ENGINE.idFromName(`engine-${hint}`), {
			locationHint: hint,
		}) as unknown as SearchEngine;
	}

	/** Single-flighted load under waitUntil; failures logged, never thrown. */
	private warmInBackground(): void {
		this.ctx.waitUntil(
			this.engine().then(
				() => {},
				(err) => console.warn(`Background colo warm failed (still relaying): ${err}`),
			),
		);
	}

	// ── Engine acquisition ─────────────────────────────────────────────────────

	private async engine(): Promise<Engine> {
		try {
			// getEngine is single-flighted and returns immediately when this
			// isolate already holds the store; otherwise it streams the store in
			// from KV (~4 immutable, colo-cached reads).
			return await getEngine(this.env, this.ctx);
		} catch (err) {
			rethrowForRpc(err);
		}
	}
}
