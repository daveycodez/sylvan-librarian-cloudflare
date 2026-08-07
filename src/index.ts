// Worker entrypoint: dispatch mirroring upstream's APIResource._handle /
// _resolve_action (vendor/sylvan_librarian/api/api_resource.py:641-731), with
// falcon's JSON error serializer shape for all HTTP errors.

import { bootstrapPage } from "./engine/bootstrap-page";
import { RemoteEngine } from "./engine/remote-engine";
import { SearchEngine } from "./engine/search-engine-do";
import { getEngine, manifestPollAlarm, tryGetLoadedEngine, warmInBackground } from "./engine/store";
import type { Engine, Env } from "./engine/types";
import { EngineUnavailableError } from "./engine/types";
import { ImportCoordinator } from "./import-coordinator";
import { buildRoutesListing, routes } from "./routes";
import { httpError, securityHeaders } from "./routes/http";
import { enforceRateLimit, isRateLimitedRoute, isTrustedRequest } from "./routes/rate-limit";

export { ImportCoordinator, SearchEngine };

// Hybrid engine routing: a warm isolate answers locally (full horizontal
// scale); a cold isolate forwards to its REGION's session-warm SearchEngine
// DO while warming itself in the background. One DO per location hint,
// created near the traffic that names it.
const CONTINENT_TO_HINT: Record<string, DurableObjectLocationHint> = {
	AF: "afr",
	AN: "oc",
	AS: "apac",
	EU: "weur",
	NA: "wnam",
	OC: "oc",
	SA: "sam",
};

function resolveEngine(request: Request, env: Env, ctx: ExecutionContext, source: { tag: string }): Promise<Engine> {
	const local = tryGetLoadedEngine();
	if (local) {
		source.tag = "isolate";
		return getEngine(env, ctx); // resolves immediately + background staleness check
	}
	warmInBackground(env, (p) => ctx.waitUntil(p));
	const hint = CONTINENT_TO_HINT[(request.cf as { continent?: string } | undefined)?.continent ?? "NA"] ?? "wnam";
	source.tag = `do-${hint}`;
	const stub = env.SEARCH_ENGINE.get(env.SEARCH_ENGINE.idFromName(`engine-${hint}`), { locationHint: hint });
	return Promise.resolve(new RemoteEngine(stub));
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
	const finish = (response: Response): Response => {
		const out = securityHeaders(response);
		if (engineSource.tag) out.headers.set("x-sylvan-engine", engineSource.tag);
		return out;
	};

	try {
		// Per-IP rate limit on engine-computing routes only; requests carrying
		// the trusted key (server-to-server callers on shared egress IPs) skip
		// it. Cache hits never reach this code at all.
		if (isRateLimitedRoute(resolved.key, params) && !(await isTrustedRequest(env, request))) {
			const limited = await enforceRateLimit(env, request);
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
		if (
			err instanceof EngineUnavailableError &&
			err.bootstrapping &&
			(path === "_root" || path === "card" || path.startsWith("card/"))
		) {
			// Human-facing pages get the auto-refreshing "building index" page
			// during first-deploy bootstrap; JSON endpoints keep upstream's 503.
			return finish(await bootstrapPage(env));
		}
		if (err instanceof EngineUnavailableError) {
			// The store is bootstrapping or failed to load. Loud, structured,
			// never an empty result (this deployment has no SQL fallback).
			return finish(
				httpError(
					503,
					"Service Unavailable",
					err.bootstrapping
						? "The card index is being built, please retry shortly."
						: "Engine is not loaded, please try again later.",
				),
			);
		}
		console.error(`Error handling request for ${path}:`, err);
		return finish(httpError(500, "Server Error", "An internal error occurred."));
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return handle(request, env, ctx);
	},

	// Nightly store rebuild (wrangler.jsonc triggers.crons). The coordinator DO
	// serializes runs; a run already in flight makes this a no-op.
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const coordinator = env.IMPORT_COORDINATOR.get(env.IMPORT_COORDINATOR.idFromName("singleton"));
		ctx.waitUntil(coordinator.fetch("https://coordinator/start-import?reason=cron"));
		// Also refresh this isolate's view of the manifest so hot-swap lag stays bounded.
		ctx.waitUntil(manifestPollAlarm(env));
	},
} satisfies ExportedHandler<Env>;
