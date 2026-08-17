// Worker entrypoint: dispatch mirroring upstream's APIResource._handle /
// _resolve_action (vendor/sylvan_librarian/api/api_resource.py:641-731), with
// falcon's JSON error serializer shape for all HTTP errors.

import { WorkerEntrypoint } from "cloudflare:workers";
import { engineName, placeEngineStub } from "./engine/engine-namespace";
import { livePartitionedManifest, liveRoutingFilter, PartitionedEngine } from "./engine/partitioned-engine";
import { regionHint } from "./engine/region";
import { RemoteEngine } from "./engine/remote-engine";
import { SearchEngine } from "./engine/search-engine-do";
import { markShardReady, pickShard, takeWarmTarget, unmarkPending } from "./engine/shard-controller";
import { readManifest } from "./engine/store-kv";
import type { Engine, Env } from "./engine/types";
import { EngineUnavailableError } from "./engine/types";
import { ImportCoordinator } from "./import-coordinator";
import { routes, SCRYFALL_SURFACE_ROUTES } from "./routes";
import { httpError, optionsResponse, securityHeaders } from "./routes/http";
import { enforceRateLimit, isRateLimitedRoute, isTrustedRequest, RateLimiter } from "./routes/rate-limit";
import { scryfallHttpError } from "./routes/scryfall-compat/respond";
import { NOT_FOUND_DETAILS } from "./routes/scryfall-compat/routes";

export { ImportCoordinator, RateLimiter, SearchEngine };

// Engine routing: one SearchEngine DO per REGION, named by the location hint
// the request maps to (engine-wnam, engine-weur, ...) and created there.
// Isolates never load the store or serve engine queries themselves: they parse,
// RPC out, and stay tiny. Idle regions evict their DO — scale to zero.
//
// This was per-COLO, with the regional DO existing only as a relay target for a
// cold colo. The colo string was never a placement control, only a partition
// key — `idFromName` was called with no location hint, so the object was placed
// wherever Cloudflare chose near its first caller, which is regional anyway. So
// the fan-out bought nothing and cost a great deal: measured on 2026-08-12,
// production ran three objects (engine-LAX, engine-SJC, engine-wnam) for traffic
// that was 1,697 + 442 requests over two days and entirely within one region.
// Each loaded its own ~76.6MB archive, and a cold /cards/search paid TWO of them
// at once (2.38s + 1.41s of DO CPU) because the relay raced the local load
// against the region's. One request every ~80s cannot keep three objects warm;
// it comfortably keeps one warm.
//
// A region whose lone shard reports sustained queue depth fans out to
// engine-<region>-1, -2, ... (shard 0 keeps the plain name, so single-shard
// steady state is byte-identical to unsharded routing); see shard-controller.
// The cap needs no plan detection any more: a shard holds the store only in
// memory (streamed from KV), so an extra shard costs no storage at all — the
// old design pinned a 70MB SQLite copy per shard against the DO pool, which is
// why the cap used to be plan-aware. SHARDS_MAX (runtime var) overrides it.
// Engine stubs are resolved per request, and deliberately not memoised. A stub
// is a request-scoped I/O object — reusing one across requests fails with
// "Cannot perform I/O on behalf of a different request" — and caching just the
// DurableObjectId, which is a plain value, measured flat: the cost here is in
// `get()`, not in hashing the name.
async function resolveEngine(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	source: { tag: string },
): Promise<Engine> {
	const region = regionHint(request);
	// The colo THIS isolate is running in, carried into the warm-RPC log line.
	// It is the other half of the placement join: a colo that shows up serving
	// `wnam` traffic is, by definition, a colo wnam traffic arrives at, so the
	// set of them is the ground truth to check `engine-wnam`'s own self-reported
	// colo against — with no table to keep current. See ENGINE-PLACEMENT.md.
	const colo = (request.cf as { colo?: string } | undefined)?.colo ?? "?";
	// SHARDS_MAX="0" is meaningful (unbounded), so an explicit 0 must survive —
	// hence the NaN check rather than `|| undefined`, which would swallow it.
	const configured = Number.parseInt((env as { SHARDS_MAX?: string }).SHARDS_MAX ?? "", 10);
	const maxShards = Number.isNaN(configured) ? undefined : configured;
	const shard = pickShard(region, maxShards);
	source.tag = `do-${engineName(region, shard).slice("engine-".length)}`;

	// ── Partitioned serving (plan B5) ───────────────────────────────────────────
	//
	// THE ONLY SERVING PATH. The store is N partitioned archives, so every route
	// resolves through the per-route fan-out table in PartitionedEngine; there is
	// no single-archive path left to fall back to and no flag selecting between
	// them. `livePartitionedManifest` throws the loud 503 when the manifest is
	// absent or unusable, which is the honest answer — nothing published a store
	// this deployment can read.
	//
	// Stubs are still constructed only through placeEngineStub, from this request
	// isolate, so partition objects are created in the user's region exactly as
	// replica objects are. THAT MAKES THIS THE ONLY PLACE IN THE DEPLOYMENT THAT
	// MAY CREATE AN ENGINE OBJECT: `locationHint` applies at creation and never
	// again, so an object created anywhere else is misplaced permanently and
	// silently. See engine-namespace.ts, which is where the rule is enforced
	// rather than described.
	const manifest = await livePartitionedManifest(env);
	// Decision-time warm ping for a shard the controller just opened: start its
	// wake NOW rather than at its first real request, and REPORT THE OUTCOME,
	// because the shard takes no traffic until this resolves. A fresh shard is
	// ready only when EVERY partition of it can serve — admitting it on one warm
	// partition would route fan-outs into N-1 cold loads at once — so the ping is
	// N `cardCount()` calls, each of which loads its partition on a cold DO. A
	// failure gives the slot back rather than stranding it, and routing never
	// waits on any of it: existing shards carry the load throughout.
	const warmTarget = takeWarmTarget(region);
	if (warmTarget !== null) {
		const count = manifest.partition_count as number;
		ctx.waitUntil(
			Promise.all(
				Array.from({ length: count }, (_, p) =>
					new RemoteEngine(placeEngineStub(env, region, warmTarget, p), region, colo).cardCount(),
				),
			)
				.then(() => markShardReady(region, warmTarget))
				.catch((err) => {
					unmarkPending(region);
					console.warn(`[${region}] warm ping for shard ${warmTarget} failed (slot released): ${err}`);
				}),
		);
	}
	return new PartitionedEngine(
		(partition) => new RemoteEngine(placeEngineStub(env, region, shard, partition), region, colo),
		manifest,
		// The stale-modulus retry (Decision 3b): re-read the one manifest key.
		() => readManifest(env),
		// The bare-id routing hints, if this isolate already holds them. Returns null
		// on a cold isolate and loads them in the background — the fan-out is correct
		// without it, so nothing here waits on a 740KB KV read.
		liveRoutingFilter(env, manifest, (p) => ctx.waitUntil(p)),
	);
}

// Upstream DISALLOWED_QUERY_ARGS: these names are reserved for internal
// plumbing and are stripped from client query params before binding.
const DISALLOWED_QUERY_ARGS = new Set(["falcon_response", "request_host"]);

function resolveAction(path: string): { key: string; positionalArgs: string[] } | null {
	// Exact match first: flat routes like "static/favicon.ico" and "index.html"
	// register their full slash/dot-containing path as the route key.
	if (path in routes) return { key: path, positionalArgs: [] };
	const [actionWord = "", ...actionArgs] = path.split("/");
	const entry = routes[actionWord];
	// A matched route that can't absorb this many trailing segments means the
	// path identifies nothing — 404, not a 400 (upstream parity).
	if (!entry || actionArgs.length > entry.positionalCapacity) return null;
	return { key: actionWord, positionalArgs: actionArgs };
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.replace(/^\/+|\/+$/g, "") || "_root";

	const resolved = resolveAction(path);
	// AN UNKNOWN PATH GETS SCRYFALL'S ERROR OBJECT, not upstream's routes listing.
	//
	// This deployment exists so a client can change one base URL and stop talking to
	// api.scryfall.com, and that has to hold when the client asks for something that does not
	// exist: it parses `code` and `details`, and `{title, description: {routes: ...}}` gives it
	// neither. The listing is a convenience for a human poking at the origin, and a human still has
	// it — every route this deployment serves is documented, and `/` is the web interface. What a
	// client cannot have is a body shape that stops it being pointed back at Scryfall.
	//
	// Status, wording and tier are all measured: `404`, "The requested object or REST method was not
	// found.", `no-cache`.
	if (!resolved) return scryfallHttpError("not_found", 404, NOT_FOUND_DETAILS);
	const entry = routes[resolved.key];
	if (!entry) return scryfallHttpError("not_found", 404, NOT_FOUND_DETAILS);
	/** Whether this path is on the Scryfall-compatible surface, which picks the error shape. */
	const scryfallSurface = SCRYFALL_SURFACE_ROUTES.has(resolved.key);
	// CORS PREFLIGHT, answered before the method check — which is what makes it work at all: no
	// route in the table declares OPTIONS, so a preflight used to come back 405 and every
	// cross-origin request needing one failed in the browser before it was sent. That is not a
	// theoretical case here: `POST /cards/collection` sends `content-type: application/json`, which
	// is not a CORS-safelisted value, so a browser preflights it every time.
	//
	// The body is api.scryfall.com's own answer, verbatim, measured 2026-08-16 on `/cards/search`
	// and `/catalog/battle-types` alike — the same object on both, so this sits in dispatch rather
	// than in a route. Note the `object: "message"` envelope: Scryfall has exactly one non-error
	// use of it and this is it. The tier is Scryfall's too (a preflight answer is per-client and
	// short-lived; `Access-Control-Max-Age` is what actually caches it, and securityHeaders sends
	// that on every response).
	// `securityHeaders` explicitly, not via `finish` below (which does not exist yet at this point in
	// the function): a preflight that came back WITHOUT the CORS headers would be the one response
	// on this surface where dropping them breaks something, since the headers are the entire answer.
	if (request.method === "OPTIONS") return securityHeaders(optionsResponse());
	if (!entry.methods.includes(request.method)) {
		// A METHOD A ROUTE DOES NOT ACCEPT IS A 404 ON THE SCRYFALL SURFACE, exactly as api.scryfall.com
		// answers it — same `not_found` object, same sentence, and NO `Allow` header, which it does not
		// send either (measured 2026-08-16 across eight requests: POST/PUT/DELETE/PATCH against
		// `/cards/search`, `/cards/named`, `/cards/collection`, `/cards/:id` and `/sets`).
		//
		// This was briefly a 405 with an invented `method_not_allowed` code, on the argument that 405 is
		// the more correct HTTP answer in the abstract. It is — and it is the wrong call here, for the
		// reason the code itself gave away: Scryfall never emits a 405, so there was no measurement
		// behind that code and nothing to check it against. An error body nobody measured is the same
		// defect as a CSV column set nobody measured. A client that branches on 404-versus-405 has to see
		// what Scryfall shows it, and this deployment's job is to be substitutable.
		if (scryfallSurface) return scryfallHttpError("not_found", 404, NOT_FOUND_DETAILS);
		// Upstream's own surface keeps falcon's 405 + `Allow`: nothing there is mirroring Scryfall, and
		// 405 remains the right answer for a route that genuinely declares its methods.
		const allow = [...entry.methods].sort().join(", ");
		return httpError(405, "Method Not Allowed", `Allowed methods: ${allow}`, { Allow: allow });
	}

	const params: Record<string, string> = {};
	for (const [k, v] of url.searchParams) {
		if (!DISALLOWED_QUERY_ARGS.has(k)) params[k] = v;
	}

	const requestHost = request.headers.get("X-Proxy-Host") ?? url.host;

	// Observability: which engine answered (empty when the route never asked).
	// Cached responses replay the header from generation time; pair it with
	// cf-cache-status to distinguish edge cache hits.
	const engineSource = { tag: "" };
	const rateLimitOutcome = { tag: "" };
	const finish = (response: Response): Response => {
		const out = securityHeaders(response);
		if (engineSource.tag) out.headers.set("x-sylvan-engine", engineSource.tag);
		if (rateLimitOutcome.tag) out.headers.set("x-sylvan-rl", rateLimitOutcome.tag);
		return out;
	};

	try {
		// Per-IP rate limit on engine-computing routes only; requests carrying
		// the trusted key (server-to-server callers on shared egress IPs) skip
		// it. Cache hits never reach this code at all.
		if (isRateLimitedRoute(resolved.key, params) && !(await isTrustedRequest(env, request))) {
			const { outcome, response: limited } = enforceRateLimit(env, request, (p) => ctx.waitUntil(p));
			rateLimitOutcome.tag = outcome;
			if (limited) return finish(limited);
		}

		const response = await entry.handler(
			{
				env,
				getEngine: () => resolveEngine(request, env, ctx, engineSource),
				request,
				requestHost,
				waitUntil: (p) => ctx.waitUntil(p),
			},
			resolved.positionalArgs,
			params,
		);
		return finish(response);
	} catch (err) {
		if (err instanceof Response) return finish(err); // redirects (HTTPMovedPermanently parity)
		if (err instanceof EngineUnavailableError) {
			// The index is built by the DEPLOY (scripts/import-store.sh), which
			// fails rather than shipping a Worker without one — so reaching here
			// means something broke after a good deploy, most likely the KV
			// namespace being deleted or emptied under a running deployment.
			//
			// The reason travels in `description`, which the existing UI already
			// surfaces: app.js reads title/description off a non-ok JSON body and
			// renders it through showError(). So one structured 503 serves both
			// the API and the page — no bespoke error page needed.
			// Upstream's exact wording — tests pin it, and the UI renders
			// `description` via showError(), so this reaches the browser and the
			// API alike. The specific cause (a deleted KV namespace, a binding that
			// stopped resolving) goes to the log, where a diagnostic belongs.
			console.error(`Card index unavailable: ${err.message}`);
			// Same split: a `/cards/*` client waiting out a cold store gets Scryfall's error object,
			// and the web interface keeps the `{title, description}` its showError() renders.
			return finish(
				scryfallSurface
					? scryfallHttpError("service_unavailable", 503, "Engine is not loaded, please try again later.")
					: httpError(503, "Service Unavailable", "Engine is not loaded, please try again later."),
			);
		}
		console.error(`Error handling request for ${path}:`, err);
		return finish(
			scryfallSurface
				? scryfallHttpError("internal_error", 500, "An internal error occurred.")
				: httpError(500, "Server Error", "An internal error occurred."),
		);
	}
}

/**
 * A class rather than the plain `{ fetch, scheduled }` object it used to be,
 * for exactly one reason: `purgeCache` below has to be callable as an RPC
 * method ON THIS ENTRYPOINT, and a plain object export exposes only the
 * handlers the runtime knows about.
 */
export default class SylvanLibrarian extends WorkerEntrypoint<Env> {
	override fetch(request: Request): Promise<Response> {
		return handle(request, this.env, this.ctx);
	}

	// Nightly store rebuild (wrangler.jsonc triggers.crons). The coordinator DO
	// serializes runs; a run already in flight makes this a no-op.
	override async scheduled(_controller: ScheduledController): Promise<void> {
		const coordinator = this.env.IMPORT_COORDINATOR.get(this.env.IMPORT_COORDINATOR.idFromName("singleton"));
		this.ctx.waitUntil(coordinator.fetch("https://coordinator/start-import?reason=cron"));
		// Nothing to poll here any more. This used to also kick manifestPollAlarm to
		// bound hot-swap lag, which was inert anyway (it ran in a Worker isolate,
		// where no store is ever loaded) and is now unnecessary: the coordinator
		// pushes the new store to every region's DO in its own `notify` phase.
	}

	/**
	 * Drop every response this Worker has cached (wrangler.jsonc `cache`).
	 * Called over RPC by ImportCoordinator once a nightly rebuild is live and
	 * the engine DOs have had time to pick it up — see that file's `purge` phase
	 * for the timing, which is the subtle half of this.
	 *
	 * It has to live HERE, on the default entrypoint, because a Workers Cache
	 * purge is scoped to the entrypoint that issues it, and every cached
	 * response this deployment holds was stored by this one. The coordinator is
	 * a Durable Object — never an entrypoint, never itself cached — so a purge
	 * issued from inside it would reach nothing.
	 *
	 * `purgeEverything` rather than a path list, because "the tiers that carry
	 * card data" is very nearly everything: `/search`, `/catalog` and all of
	 * `/cards/*`, plus the root page, which embeds search results. What is left
	 * is page HTML on an hour of edge TTL, and re-rendering one of those costs a
	 * template fill. Static assets never enter this cache at all — they are
	 * served by the assets layer without invoking the Worker.
	 *
	 * Never throws. By the time this runs the store is already published, and a
	 * purge that fails just leaves the pre-purge behaviour: stale answers expire
	 * on their own TTL. Failing the run over it would be strictly worse, so the
	 * result comes back as a value for the caller to log.
	 */
	async purgeCache(): Promise<CachePurgeResult> {
		// Optional in the runtime types because a Worker can be deployed without
		// `cache.enabled`; treated as a reportable failure rather than a crash so
		// turning caching off never takes the nightly import down with it.
		const cache = this.ctx.cache;
		if (!cache) {
			return { success: false, errors: [{ code: 0, message: "Workers Cache is not enabled for this Worker" }] };
		}
		try {
			return await cache.purge({ purgeEverything: true });
		} catch (err) {
			return { success: false, errors: [{ code: 0, message: String(err) }] };
		}
	}
}
