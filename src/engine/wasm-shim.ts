// Workers-compatible instantiation of the wasm-bindgen bundler-target pkg.
//
// Wrangler's CompiledWasm rule resolves a .wasm import to a WebAssembly.Module
// (not instantiated exports, which webpack-style bundlers provide), so the
// pkg's own entry glue (`sylvan_engine_wasm.js`) cannot run in workerd. This
// shim does what that glue expects its bundler to have done: instantiation
// with the bindgen import object, then handing the exports to the glue. The
// `sylvan-engine-wasm` alias in wrangler config points here.
//
// Instantiation is LAZY, and that is the point. It used to run at module
// scope, which meant every isolate paid it — and isolates never query the
// engine. They parse a query, RPC to a SearchEngine Durable Object, and hand
// back the answer; only the DO ever touches wasm. Instantiating a 1.4MB module
// in each of them showed up as ~14ms of Worker startup, landing on whichever
// request happened to be first in a fresh isolate. With search-as-you-type
// spraying novel (cache-missing) queries across colos and isolates, that cost
// was being paid over and over against the free plan's 10ms-per-request CPU
// limit.
//
// ── ONE INSTANCE PER LABEL (partitioned stores) ────────────────────────────────
//
// The Rust engine keeps its loaded store in module-global state, so one wasm
// INSTANCE holds exactly one store. Durable Object instances of one class can be
// COLOCATED in a single isolate, and with partitioned stores several partition
// objects (engine-wnam-p0, engine-wnam-p1, ...) may therefore share this module
// — a single instance would have them clobbering each other's archives. So the
// shim keeps a Map of instances keyed by the DO's label, all instantiated from
// the SAME compiled module.
//
// COST OF THE DESIGN, measured against the alternatives it rejects:
//   - The COMPILE is shared: wrangler hands over a compiled WebAssembly.Module
//     once per isolate (~1.4MB of code), and every instance below reuses it.
//   - Each `new WebAssembly.Instance` is low-single-digit milliseconds (it runs
//     the bindgen start + panic hook), paid ONCE per label per isolate life —
//     the same class of cost the old per-isolate instantiation was.
//   - The real per-label cost is LINEAR MEMORY: each instance holds its own
//     store (~48MB per partition at N=8, plus ~1.6MB of engine fixed overhead),
//     and linear memory never shrinks. Colocating k partition objects in one
//     isolate therefore costs ~k × (partition + 1.6MB) against the 128MB
//     ceiling — about TWO 48MB partitions per isolate in practice, which is why
//     the plan's colocation probe (B8 #6) matters and why partition objects are
//     separate DOs that workerd is free to spread across isolates.
//   - Per-call dispatch cost is a Map lookup and a pointer compare; a label
//     SWITCH additionally detaches one ArrayBuffer wrapper (see bindTo). None
//     of it scales with payload.
//
// WHY BINDING SWAPS A MODULE-GLOBAL POINTER rather than duplicating the glue:
// the wasm-bindgen glue (`sylvan_engine_wasm_bg.js`) is a single ES module
// holding one `wasm` exports reference (set via `__wbg_set_wasm`) and one
// cached Uint8Array view over `wasm.memory.buffer`. ES modules cannot be
// instantiated per label, so instead every call binds first: point the glue at
// the right instance, and invalidate its memory-view cache. The cache refreshes
// only when its buffer's `byteLength === 0` — i.e. when the buffer is DETACHED —
// and the JS-API spec detaches a Memory's buffer on every `grow()`, including
// `grow(0)`. So switching labels grows the OUTGOING instance's memory by 0
// pages: its old buffer detaches (contents untouched — the wrapper object is
// replaced, not the memory), the stale cached view reads byteLength 0, and the
// glue lazily rebuilds its view over the newly bound instance's buffer.
// Calls are synchronous on a single-threaded isolate, so a bound pointer cannot
// change mid-call; every await boundary in the loader re-binds through its
// EngineHandle before touching wasm again.

import * as bg from "../../engine/wasm/pkg/sylvan_engine_wasm_bg.js";
// The pkg's generated .wasm.d.ts types this as the exports object (webpack
// semantics); under wrangler's CompiledWasm rule it is actually a Module.
import wasmModule from "../../engine/wasm/pkg/sylvan_engine_wasm_bg.wasm";

interface EngineInstance {
	exports: WebAssembly.Exports;
	memory: WebAssembly.Memory | null;
}

const instances = new Map<string, EngineInstance>();
/** Which label's instance the glue currently points at; null before first use. */
let bound: string | null = null;
/**
 * How many times each label's instance has been DROPPED after a trap. A loaded store belongs to
 * the instance it was loaded into; the loader records this at load and stops trusting its store
 * the moment it moves (see store.ts liveCurrent).
 */
const generations = new Map<string, number>();

/** The engine crate's prefix for "this instance is unusable" (engine/wasm/src/lib.rs POISONED_PREFIX). */
const POISONED_PREFIX = "engine poisoned: ";

/**
 * Whether an error thrown out of wasm means the INSTANCE is broken rather than the call. A trap
 * (`RuntimeError`: unreachable, OOB, a panic under panic=abort) never runs Rust's drops, so any
 * borrow the trapped call held stays counted; a stack overflow surfaces as a `RangeError`; and a
 * later call that meets such a leftover borrow reports the engine's poisoned prefix.
 */
function breaksInstance(err: unknown): boolean {
	if (err instanceof WebAssembly.RuntimeError || err instanceof RangeError) return true;
	return err instanceof Error && err.message.includes(POISONED_PREFIX);
}

/**
 * Forget `label`'s instance so the next call instantiates a fresh one. Its linear memory becomes
 * unreachable and collectable — the only way wasm memory is ever given back — and whatever store
 * it held is gone with it, which the generation bump tells the loader.
 */
function dropInstance(label: string, err: unknown): void {
	const dropped = instances.get(label);
	if (!dropped) return;
	instances.delete(label);
	// Detach its buffer exactly as bindTo does for an outgoing instance: the glue caches a view
	// of the BOUND memory and rebuilds it only when that view's byteLength is 0. Without this the
	// next instance (this label's or a sibling's) would be bound while the glue still marshalled
	// through the dead instance's memory — every argument written into the wrong buffer, every
	// reload failing on garbage, and the dead memory pinned for the isolate's life.
	dropped.memory?.grow(0);
	if (bound === label) bound = null;
	generations.set(label, (generations.get(label) ?? 0) + 1);
	console.error(`[${label || "default"}] wasm engine instance dropped after: ${err}; the next call starts a fresh one`);
}

function instantiate(): EngineInstance {
	const instance = new WebAssembly.Instance(wasmModule as unknown as WebAssembly.Module, {
		"./sylvan_engine_wasm_bg.js": bg,
	});
	return {
		exports: instance.exports,
		memory: (instance.exports as { memory?: WebAssembly.Memory }).memory ?? null,
	};
}

/**
 * Point the glue at `label`'s instance, creating it on first use.
 *
 * The start hook runs AFTER the glue is pointed at the new instance, because
 * wasm code started here may call back into glue imports that read linear
 * memory through the module-global pointer.
 */
function bindTo(label: string): EngineInstance {
	let inst = instances.get(label);
	const fresh = inst === undefined;
	if (!inst) {
		inst = instantiate();
		instances.set(label, inst);
	}
	if (bound !== label) {
		// Detach the outgoing instance's buffer so the glue's cached memory view
		// (which points at it, with a non-zero byteLength) is forced to rebuild
		// over the instance being bound. grow(0) detaches per the JS-API spec and
		// moves no memory.
		if (bound !== null) instances.get(bound)?.memory?.grow(0);
		bg.__wbg_set_wasm(inst.exports);
		bound = label;
	}
	if (fresh) {
		(inst.exports as { __wbindgen_start?: () => void }).__wbindgen_start?.();
		// Wasm panics must land in console.error, not die silently with the isolate.
		bg.__init_panic_hook();
	}
	return inst;
}

/** The label the module-level exports (and `ensureEngine`) operate on. */
const DEFAULT_LABEL = "";

/**
 * Instantiate the default engine, once per isolate, on first use.
 *
 * Kept for the label-less callers (tests, tooling); the store loader itself
 * goes through `engineFor` so each Durable Object label gets its own instance.
 * Cheap to call repeatedly; a no-op after the first.
 */
export function ensureEngine(): void {
	bindTo(DEFAULT_LABEL);
}

/**
 * Wasm LINEAR MEMORY currently reserved by the DEFAULT instance, in bytes.
 *
 * Linear memory NEVER SHRINKS, so this is a high-water mark for the instance's
 * life, not a live gauge: after a store load it is the load's peak. Zero before
 * anything instantiates. Per-label figures come from the label's own
 * EngineHandle.
 */
export function linearMemoryBytes(): number {
	return instances.get(DEFAULT_LABEL)?.memory?.buffer.byteLength ?? 0;
}

/** Everything the store loader calls, bound to one label's instance. */
export interface EngineHandle {
	begin_store_load(totalLen: number): void;
	store_load_chunk(chunk: Uint8Array): void;
	finish_store_load(): void;
	begin_store_load_gzip(totalLen: number): void;
	store_load_gzip_chunk(chunk: Uint8Array): void;
	finish_store_load_gzip(): void;
	unload_store(): void;
	store_loaded(): boolean;
	query(filterTreeJson: string, optsJson: string): string;
	query_rows(filterTreeJson: string, optsJson: string): Uint8Array;
	query_keys(filterTreeJson: string, optsJson: string, inlineRows: number, shape: string, baseUrl: string): Uint8Array;
	fetch_rows(vpids: Uint32Array, fieldsJson: string, shape: string, baseUrl: string): Uint8Array;
	sort_key_version(): number;
	scryfall_search(filterTreeJson: string, optsJson: string, baseUrl: string): Uint8Array;
	query_widens(filterTreeJson: string, optsJson: string): boolean;
	catalog(): string;
	random_search(n: number, seed: bigint, filterTreeJson: string, fieldsJson: string): string;
	size(): number;
	card_by_scryfall_id(scryfallId: string, fieldsJson: string): string;
	cards_by_scryfall_ids(idsJson: string, fieldsJson: string): string;
	printings_of_oracle_id(oracleId: string, fieldsJson: string): string;
	card_by_external_id(namespace: string, externalId: bigint, fieldsJson: string): string;
	fuzzy_card_by_name(name: string, floor: number, lead: number, fieldsJson: string): string;
	fuzzy_candidates(name: string, floor: number, k: number): Uint8Array;
	autocomplete(prefix: string, limit: number): string;
	exact_card_by_name(folded: string, setCode: string, fieldsJson: string): string;
	exact_name_rank(folded: string, setCode: string): string;
	collection_cards_by_names(identifiersJson: string, fieldsJson: string, prefer: string, scopeJson: string): string;
	collection_name_ranks(identifiersJson: string, prefer: string, scopeJson: string): string;
	collection_batch(requestJson: string, fieldsJson: string, baseUrl: string): Uint8Array;
	card_by_illustration_id(illustrationId: string, fieldsJson: string): string;
	cards_containing_all_words(wordsJson: string, setCode: string, limit: number, fieldsJson: string): string;
	linearMemoryBytes(): number;
	/** Bumped each time this label's instance is dropped after a trap; see dropInstance. */
	instanceGeneration(): number;
}

/** The glue's callable surface, for the generic wrapper below. */
type GlueFns = Record<string, (...args: never[]) => unknown>;

/**
 * The engine instance for `label` — every method binds the glue to that
 * label's instance before crossing into wasm, so interleaved calls from
 * colocated Durable Objects each reach their own store.
 */
export function engineFor(label: string): EngineHandle {
	const wrap =
		<A extends unknown[], R>(name: string) =>
		(...args: A): R => {
			bindTo(label);
			try {
				return (bg as unknown as GlueFns)[name]?.(...(args as unknown as never[])) as R;
			} catch (err) {
				if (breaksInstance(err)) dropInstance(label, err);
				throw err;
			}
		};
	return {
		begin_store_load: wrap("begin_store_load"),
		store_load_chunk: wrap("store_load_chunk"),
		finish_store_load: wrap("finish_store_load"),
		begin_store_load_gzip: wrap("begin_store_load_gzip"),
		store_load_gzip_chunk: wrap("store_load_gzip_chunk"),
		finish_store_load_gzip: wrap("finish_store_load_gzip"),
		unload_store: wrap("unload_store"),
		store_loaded: wrap("store_loaded"),
		query: wrap("query"),
		query_rows: wrap("query_rows"),
		query_keys: wrap("query_keys"),
		fetch_rows: wrap("fetch_rows"),
		sort_key_version: wrap("sort_key_version"),
		scryfall_search: wrap("scryfall_search"),
		query_widens: wrap("query_widens"),
		catalog: wrap("catalog"),
		random_search: wrap("random_search"),
		size: wrap("size"),
		card_by_scryfall_id: wrap("card_by_scryfall_id"),
		cards_by_scryfall_ids: wrap("cards_by_scryfall_ids"),
		printings_of_oracle_id: wrap("printings_of_oracle_id"),
		card_by_external_id: wrap("card_by_external_id"),
		fuzzy_card_by_name: wrap("fuzzy_card_by_name"),
		// The gather's cross-partition race reads this; omitting it here while the
		// pkg exported it and wasm-module.d.ts declared it made /cards/named?fuzzy=
		// throw "not a function" at runtime on every query whose race actually ran.
		fuzzy_candidates: wrap("fuzzy_candidates"),
		autocomplete: wrap("autocomplete"),
		exact_card_by_name: wrap("exact_card_by_name"),
		exact_name_rank: wrap("exact_name_rank"),
		collection_cards_by_names: wrap("collection_cards_by_names"),
		collection_name_ranks: wrap("collection_name_ranks"),
		collection_batch: wrap("collection_batch"),
		card_by_illustration_id: wrap("card_by_illustration_id"),
		cards_containing_all_words: wrap("cards_containing_all_words"),
		linearMemoryBytes: () => instances.get(label)?.memory?.buffer.byteLength ?? 0,
		instanceGeneration: () => generations.get(label) ?? 0,
	};
}

export * from "../../engine/wasm/pkg/sylvan_engine_wasm_bg.js";
