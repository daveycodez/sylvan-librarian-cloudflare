// Route table contract, mirroring upstream's @route/iter_marked_routes machinery
// (vendor/sylvan_librarian/api/utils/routing.py + api_resource.py __init__).
//
// Keys are upstream's route keys verbatim: a handler's method name ("search",
// "get_catalog", "_root", ...) or an explicit path from @route(paths=...)
// ("index.html", "static/favicon.ico", "robots.txt", ...). Dispatch in
// src/index.ts reproduces upstream _handle/_resolve_action semantics.

import type { Engine, Env } from "../engine/types";

export interface RouteContext {
	env: Env;
	/** Resolves the loaded engine, or throws EngineUnavailableError (bootstrap page / 503 parity). */
	getEngine(): Promise<Engine>;
	request: Request;
	/** Upstream: X-Proxy-Host header, else Host. */
	requestHost: string;
	waitUntil(p: Promise<unknown>): void;
}

export interface RouteEntry {
	/**
	 * Handler. positionalArgs are trailing path segments (upstream's action_args);
	 * params are query params minus upstream's DISALLOWED_QUERY_ARGS, uncoerced —
	 * handlers coerce via src/routes/param-binding.ts to mirror upstream errors.
	 */
	handler(ctx: RouteContext, positionalArgs: string[], params: Record<string, string>): Promise<Response> | Response;
	/** Upstream RouteSpec.methods; dispatch answers 405 for others. */
	methods: readonly string[];
	/** Max positional path segments the handler absorbs (upstream positional_capacity). 0 unless noted. */
	positionalCapacity: number;
	/** Entry in the 404 routes listing: upstream _build_routes_listing shape. */
	listing: {
		doc: string;
		args: { name: string; type: string }[];
		kwargs: Record<string, { type: string; default: unknown }>;
	};
}

export type RouteTable = Record<string, RouteEntry>;
