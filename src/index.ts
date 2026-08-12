// Worker entrypoint: dispatch mirroring upstream's APIResource._handle /
// _resolve_action (vendor/sylvan_librarian/api/api_resource.py:641-731), with
// falcon's JSON error serializer shape for all HTTP errors.

import { WorkerEntrypoint } from "cloudflare:workers";
import { regionHint } from "./engine/region";
import { RemoteEngine } from "./engine/remote-engine";
import { SearchEngine } from "./engine/search-engine-do";
import { pickShard, takeWarmTarget } from "./engine/shard-controller";
import { manifestPollAlarm } from "./engine/store";
import type { Engine, Env } from "./engine/types";
import { EngineUnavailableError } from "./engine/types";
import { ImportCoordinator } from "./import-coordinator";
import { buildRoutesListing, routes } from "./routes";
import { httpError, securityHeaders } from "./routes/http";
import { enforceRateLimit, isRateLimitedRoute, isTrustedRequest, RateLimiter } from "./routes/rate-limit";

export { ImportCoordinator, RateLimiter, SearchEngine };

// Engine routing: one SearchEngine DO per colo, named by the colo the request
// landed in and created there (per-colo naming needs no location hint — the
// DO is placed near its first caller). Isolates never load the store or serve
// engine queries themselves: they parse, RPC out, and stay tiny. Sharding
// therefore tracks the traffic distribution (each colo's DO carries that
// colo's load), and idle colos evict their DO — scale to zero. The request's
// REGION rides along as the fallback hint: a cold colo DO relays to the
// regional DO (engine-wnam, ...) while waking in the background, so an
// evicted colo never makes a user wait on the ~1s store wake.
// A colo whose lone shard reports sustained queue depth fans out to
// engine-<colo>-1, -2, ... (shard 0 keeps the plain name, so single-shard
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
function resolveEngine(request: Request, env: Env, ctx: ExecutionContext, source: { tag: string }): Promise<Engine> {
	const colo = (request.cf as { colo?: string } | undefined)?.colo ?? "local";
	// SHARDS_MAX="0" is meaningful (unbounded), so an explicit 0 must survive —
	// hence the NaN check rather than `|| undefined`, which would swallow it.
	const configured = Number.parseInt((env as { SHARDS_MAX?: string }).SHARDS_MAX ?? "", 10);
	const maxShards = Number.isNaN(configured) ? undefined : configured;
	const shard = pickShard(maxShards);
	const name = shard === 0 ? `engine-${colo}` : `engine-${colo}-${shard}`;
	source.tag = `do-${name.slice("engine-".length)}`;
	const stub = env.SEARCH_ENGINE.get(env.SEARCH_ENGINE.idFromName(name));
	// Decision-time warm ping for a shard the controller just opened: start
	// its wake NOW rather than at its first real request (the ping's relay
	// also touches/wakes the regional fallback). Fire-and-forget — routing
	// never waits on it.
	const warmTarget = takeWarmTarget();
	if (warmTarget !== null) {
		const warmStub = env.SEARCH_ENGINE.get(env.SEARCH_ENGINE.idFromName(`engine-${colo}-${warmTarget}`));
		ctx.waitUntil(
			new RemoteEngine(warmStub, regionHint(request)).size().catch((err) => {
				console.warn(`Warm ping for shard ${warmTarget} failed: ${err}`);
			}),
		);
	}
	return Promise.resolve(new RemoteEngine(stub, regionHint(request)));
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
	if (!resolved) {
		// Upstream 404: description carries the full routes listing.
		return httpError(404, "Not Found", { routes: buildRoutesListing() });
	}
	const entry = routes[resolved.key];
	if (!entry) return httpError(404, "Not Found", { routes: buildRoutesListing() });
	if (!entry.methods.includes(request.method)) {
		return httpError(405, "Method Not Allowed", `Allowed methods: ${[...entry.methods].sort().join(", ")}`, {
			Allow: [...entry.methods].sort().join(", "),
		});
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
			return finish(httpError(503, "Service Unavailable", "Engine is not loaded, please try again later."));
		}
		console.error(`Error handling request for ${path}:`, err);
		return finish(httpError(500, "Server Error", "An internal error occurred."));
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
		// Also refresh this isolate's view of the manifest so hot-swap lag stays bounded.
		this.ctx.waitUntil(manifestPollAlarm(this.env));
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
