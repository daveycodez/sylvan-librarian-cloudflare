// Worker entrypoint: dispatch mirroring upstream's APIResource._handle /
// _resolve_action (vendor/sylvan_librarian/api/api_resource.py:641-731), with
// falcon's JSON error serializer shape for all HTTP errors.

import { bootstrapPage } from "./engine/bootstrap-page";
import { getEngine, manifestPollAlarm } from "./engine/store";
import type { Env } from "./engine/types";
import { EngineUnavailableError } from "./engine/types";
import { ImportCoordinator } from "./import-coordinator";
import { buildRoutesListing, routes } from "./routes";
import { httpError, securityHeaders } from "./routes/http";

export { ImportCoordinator };

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

	try {
		const response = await entry.handler(
			{
				env,
				getEngine: () => getEngine(env, ctx),
				request,
				requestHost,
				waitUntil: (p) => ctx.waitUntil(p),
			},
			resolved.positionalArgs,
			params,
		);
		return securityHeaders(response);
	} catch (err) {
		if (err instanceof Response) return securityHeaders(err); // redirects (HTTPMovedPermanently parity)
		if (err instanceof EngineUnavailableError && err.bootstrapping && (path === "_root" || path === "card" || path.startsWith("card/"))) {
			// Human-facing pages get the auto-refreshing "building index" page
			// during first-deploy bootstrap; JSON endpoints keep upstream's 503.
			return securityHeaders(await bootstrapPage(env));
		}
		if (err instanceof EngineUnavailableError) {
			// The store is bootstrapping or failed to load. Loud, structured,
			// never an empty result (this deployment has no SQL fallback).
			return securityHeaders(
				httpError(503, "Service Unavailable", err.bootstrapping ? "The card index is being built, please retry shortly." : "Engine is not loaded, please try again later."),
			);
		}
		console.error(`Error handling request for ${path}:`, err);
		return securityHeaders(httpError(500, "Server Error", "An internal error occurred."));
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return handle(request, env, ctx);
	},

	// Nightly store rebuild (wrangler.jsonc triggers.crons). The coordinator DO
	// serializes runs; a run already in flight makes this a no-op.
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		const coordinator = env.IMPORT_COORDINATOR.get(env.IMPORT_COORDINATOR.idFromName("singleton"));
		ctx.waitUntil(coordinator.fetch("https://coordinator/start-import?reason=cron"));
		// Also refresh this isolate's view of the manifest so hot-swap lag stays bounded.
		ctx.waitUntil(manifestPollAlarm(env));
	},
} satisfies ExportedHandler<Env>;
