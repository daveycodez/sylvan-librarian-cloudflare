// What ONE engine object's SQLite holds through a publish — the per-object half of the 5GB pool
// (backlog x1), measured on the build this harness just published, through the REAL loader
// (src/engine/store.ts), the REAL query engine wasm and a real SQLite.
//
// The pool gate (import-budget.ts projectCachePool) multiplies one number by every replica object:
// how many builds' worth of cache an object holds at its worst moment. Before x1 that was two —
// the publish prefetched the new build beside the old one and dropped the old at the end, and a
// cold object that nobody told loaded the new build while the old one's rows still sat there — and
// SQLite keeps the pages its deletes free, so the worst moment is also the file's lasting size.
// After x1 every fill drops the older build first. This checks that on real bytes, for both cache
// codecs and both ways an object meets a new build, and says what the file ends at.
//
// Two numbers per object, both from the database itself rather than from row sizes:
//   live  (page_count - freelist_count) x page_size, sampled after EVERY statement the loader
//         issues — the high-water of what the object held at once
//   file  page_count x page_size at the end — the file's own high-water mark, which deletes never
//         lower (workerd's databaseSize reports live pages; the file keeps the mark: see the x1
//         commit for the workerd measurement)

import { chunkKey, MANIFEST_KEY } from "../../src/engine/store-kv";
import type { StoreManifest } from "../../src/engine/types";
import { type FakeKV, MeteredStorage } from "./storage";

export interface EnginePoolReport {
	lines: string[];
	ok: boolean;
}

interface Sampled {
	storage: MeteredStorage;
	/** The live high-water since the last reset. */
	peak(): number;
	live(): number;
	file(): number;
	resetPeak(): void;
}

function pragma(storage: MeteredStorage, name: string): number {
	const row = storage.db.query(`PRAGMA ${name}`).all()[0] as Record<string, number> | undefined;
	return Number(row ? Object.values(row)[0] : 0);
}

/** A MeteredStorage whose `sql.exec` samples the live size after every statement. */
function sampledStorage(): Sampled {
	const storage = new MeteredStorage();
	const pageSize = pragma(storage, "page_size");
	const live = () => (pragma(storage, "page_count") - pragma(storage, "freelist_count")) * pageSize;
	let peak = live();
	const inner = storage.sql;
	const sql = {
		exec: (query: string, ...bindings: unknown[]) => {
			const out = inner.exec(query, ...bindings);
			peak = Math.max(peak, live());
			return out;
		},
		get databaseSize() {
			return inner.databaseSize;
		},
	};
	Object.defineProperty(storage, "sql", { get: () => sql });
	return {
		storage,
		peak: () => peak,
		live,
		file: () => pragma(storage, "page_count") * pageSize,
		resetPeak: () => {
			peak = live();
		},
	};
}

/** The same build's bytes re-keyed under an older built_at — "last night's build" for the object to hold. */
async function olderBuild(kv: FakeKV, manifest: StoreManifest, olderAt: string): Promise<StoreManifest> {
	const rekey = (key: string) => key.replace(`-${manifest.built_at}`, `-${olderAt}`);
	for (const part of manifest.partitions ?? []) {
		for (let seq = 0; seq < part.chunk_count; seq++) {
			const bytes = (await kv.get(chunkKey(part.store_key, seq), { type: "arrayBuffer" })) as ArrayBuffer;
			await kv.put(chunkKey(rekey(part.store_key), seq), bytes);
		}
	}
	// n8: its card-names blob too, so the object holds last night's names beside last night's archive.
	const names = manifest.names_key ? await kv.get(manifest.names_key, { type: "arrayBuffer" }) : null;
	if (manifest.names_key && names) await kv.put(rekey(manifest.names_key), names as ArrayBuffer);
	return {
		...manifest,
		built_at: olderAt,
		store_key: rekey(manifest.store_key),
		partitions: (manifest.partitions ?? []).map((p) => ({ ...p, store_key: rekey(p.store_key) })),
		...(manifest.names_key ? { names_key: rekey(manifest.names_key) } : {}),
	};
}

const mb = (n: number) => `${(n / 1e6).toFixed(2)}MB`;

export async function measureEnginePool(kv: FakeKV): Promise<EnginePoolReport> {
	const store = await import("../../src/engine/store");
	const cache = await import("../../src/engine/store-cache");
	const published = JSON.parse(String(await kv.get(MANIFEST_KEY, { type: "text" }))) as StoreManifest;
	const older = await olderBuild(kv, published, String(Number(published.built_at) - 86_400_000));
	// The largest partition: the object whose file sets the per-object factor.
	const parts = published.partitions ?? [];
	const partition = parts.reduce(
		(best, p, k) => ((p.store_gzip_bytes ?? 0) > (parts[best]?.store_gzip_bytes ?? 0) ? k : best),
		0,
	);
	const gzipBytes = parts[partition]?.store_gzip_bytes ?? 0;
	// Every KV get of a card-names key, counted: n8's promise is one per object per build, never on a wake.
	const namesReads: string[] = [];
	const countingKv = {
		get: (key: string, opts: unknown) => {
			if (key.startsWith("store:card-names-")) namesReads.push(key);
			return kv.get(key, opts as never);
		},
	};
	const env = { STORE_KV: countingKv } as unknown as Parameters<typeof store.prefetchStore>[0];
	const named = Boolean(published.names_key);

	const lines = [
		`engine objects (partition ${partition}, one build = ${mb(gzipBytes)} gzip): live = the most the object held at once, file = its SQLite's size after`,
	];
	let ok = true;
	let n = 0;
	for (const codec of ["gzip", "lz4"] as const) {
		const withCodec = (m: StoreManifest): StoreManifest => ({ ...m, cache: { v: 1, codec, projected_lz4_bytes: 1 } });
		const [from, to] = [withCodec(older), withCodec(published)];
		await kv.put(MANIFEST_KEY, JSON.stringify(to));
		for (const path of ["warm publish (prepare → commit)", "cold load of a build it was never told of"] as const) {
			n += 1;
			const s = sampledStorage();
			const pending: Promise<unknown>[] = [];
			const ctxFor = (label: string) => ({
				label,
				partition,
				storage: s.storage as unknown as NonNullable<Parameters<typeof store.getEngine>[1]["storage"]>,
				waitUntil: (p: Promise<unknown>) => pending.push(p),
			});
			const settle = async () => {
				while (pending.length) await pending.shift();
			};
			// No placement probe from here: a fresh record makes the loader skip the trace fetch.
			cache.recordPlacement(s.storage as never, { colo: "HARNESS", at: Date.now() });
			const label = `engine-harness${n}-p${partition}`;
			// Last night: the object loads the older build and caches it in this codec.
			await store.swapToStore(env, ctxFor(label), from);
			await settle();
			// n8: and has answered an autocomplete, so it holds that build's card names too.
			if (named) await store.autocompleteFromNames(env, ctxFor(label), "li", 20);
			const held = s.live();
			s.resetPeak();
			if (path.startsWith("warm")) {
				await store.prefetchStore(env, ctxFor(label), to);
				await store.swapToStore(env, ctxFor(label), to);
			} else {
				// Evicted, and never told (a straggler the notify did not reach): its record still names
				// the older build and KV names the new one, so its next wake loads the new build from KV.
				await store.getEngine(env, ctxFor(`engine-harness${n}b-p${partition}`));
			}
			await settle();
			const woken = path.startsWith("warm") ? label : `engine-harness${n}b-p${partition}`;
			let namesNote = "";
			if (named) {
				// The new build's names: one KV read here, then a wake (a fresh instance on the same
				// storage) must answer from SQLite.
				const before = namesReads.length;
				await store.autocompleteFromNames(env, ctxFor(woken), "li", 20);
				await store.getEngine(env, ctxFor(`engine-harness${n}c-p${partition}`));
				await store.autocompleteFromNames(env, ctxFor(`engine-harness${n}c-p${partition}`), "li", 20);
				await settle();
				const read = namesReads.length - before;
				ok &&= read === 1;
				namesNote = `; names: ${read} KV read for the new build, 0 on the wake after${read === 1 ? "" : "  <- NOT ONE"}`;
			}
			const after = s.live();
			const oneBuild = Math.max(held, after);
			// Slack for what is not cache — the manifest record, the placement row, page rounding.
			const within = s.peak() <= oneBuild * 1.05 + 64 * 1024;
			ok &&= within;
			lines.push(
				`  ${codec.padEnd(4)} ${path.padEnd(42)} held ${mb(held)} → peak ${mb(s.peak())} → ${mb(after)}; ` +
					`file ${mb(s.file())} (${(s.file() / oneBuild).toFixed(2)} builds)${within ? "" : "  <- TWO BUILDS AT ONCE"}` +
					namesNote,
			);
		}
	}
	await kv.put(MANIFEST_KEY, JSON.stringify(published));
	lines.push(ok ? "  every object held at most one build at a time" : "  FAILED: an object held two builds at once");
	return { lines, ok };
}
