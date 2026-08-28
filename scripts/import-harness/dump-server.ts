// Scryfall, as far as the harness's coordinator can tell.
//
// stepListing GETs /bulk-data and demands a `jsonl_download_uri` per dump kind;
// stepFetch then GETs each of those with a `Range: bytes=a-b` header and an
// `Accept-Encoding: identity`, and treats a 200 where it asked for a range as
// "the dump rotated under me, start over". So this server MUST honour ranges
// and answer 206 — a lazy 200-with-the-whole-body would put the coordinator in
// its restart loop forever, which is a real failure mode this harness should be
// able to reproduce rather than accidentally induce.
//
// The reference phase (post-publish) reaches api.scryfall.com for /sets,
// /catalog/* and /symbology; those are served here too, minimally, so the chain
// reaches `idle` instead of stopping on a phase that in production is
// explicitly allowed to fail.

import { CATALOG_NAMES } from "../../src/engine/reference-kv";
import type { Corpus } from "./corpus";

export interface DumpServer {
	url: string;
	stop(): void;
}

function rangeOf(header: string | null, total: number): { start: number; end: number } | null {
	if (!header) return null;
	const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const start = Number(match[1]);
	const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
	if (start >= total) return null;
	return { start, end };
}

/** One representative set/catalog/symbology payload each — enough for the
 * reference phase's shape checks, not a fixture of Scryfall's real content. */
function referencePayload(path: string): unknown | null {
	if (path === "sets") {
		return {
			object: "list",
			data: [
				{
					object: "set",
					id: "00000000-0000-4000-8000-000000000001",
					code: "hns",
					name: "Harness Set",
					set_type: "expansion",
					released_at: "2026-01-01",
					card_count: 1,
					digital: false,
					foil_only: false,
					icon_svg_uri: "https://example.invalid/hns.svg",
				},
			],
		};
	}
	if (path === "symbology") {
		return {
			object: "list",
			data: [
				{
					object: "card_symbol",
					symbol: "{W}",
					english: "one white mana",
					represents_mana: true,
					appears_in_mana_costs: true,
					cmc: 1.0,
					colors: ["W"],
					svg_uri: "https://example.invalid/W.svg",
				},
			],
		};
	}
	if (path.startsWith("catalog/")) {
		const name = path.slice("catalog/".length);
		if (!(CATALOG_NAMES as readonly string[]).includes(name)) return null;
		return { object: "catalog", uri: `https://example.invalid/${path}`, total_values: 2, data: ["Alpha", "Beta"] };
	}
	return null;
}

export function serveDumps(corpus: Corpus): DumpServer {
	// Filled in immediately after Bun.serve returns; the handler cannot close
	// over `server` itself without making its own type circular.
	let origin = "";
	const server = Bun.serve({
		port: 0,
		fetch(request: Request): Response {
			const url = new URL(request.url);
			const path = url.pathname.replace(/^\//, "");

			if (path === "bulk-data") {
				return Response.json({
					object: "list",
					has_more: false,
					data: corpus.kinds.map((kind) => ({
						object: "bulk_data",
						type: kind,
						updated_at: corpus.updatedAt,
						// The one field stepListing requires; anything missing it
						// fails the run loudly, which is the contract being kept.
						jsonl_download_uri: `${origin}/dumps/${kind}`,
						download_uri: `${origin}/dumps/${kind}`,
					})),
				});
			}

			if (path.startsWith("dumps/")) {
				const kind = path.slice("dumps/".length);
				const bytes = corpus.dumps[kind];
				if (!bytes) return new Response("no such dump", { status: 404 });
				const etag = `"${kind}-${bytes.byteLength}"`;
				const range = rangeOf(request.headers.get("range"), bytes.byteLength);
				if (!range) {
					return new Response(bytes, {
						status: 200,
						headers: { etag, "content-length": String(bytes.byteLength), "accept-ranges": "bytes" },
					});
				}
				const slice = bytes.subarray(range.start, range.end + 1);
				return new Response(slice, {
					status: 206,
					headers: {
						etag,
						"accept-ranges": "bytes",
						"content-length": String(slice.byteLength),
						"content-range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
					},
				});
			}

			const payload = referencePayload(path);
			if (payload) return Response.json(payload);
			return new Response("not found", { status: 404 });
		},
	});
	origin = server.url.origin;
	return { url: origin, stop: () => server.stop(true) };
}
