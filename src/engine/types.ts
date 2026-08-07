// Seam between the HTTP routes (src/routes/) and the wasm engine (src/engine/).
// Routes depend only on this interface; tests may inject a fake.

/** Options accepted by the engine search, mirroring upstream's pyo3 query() surface. */
export interface EngineSearchOptions {
	/** Engine-wire filter tree JSON (produced by src/parser). */
	filterTree: unknown;
	unique: string;
	prefer: string;
	orderby: string;
	direction: string;
	/** Upstream passes 1_000_000 for "no limit". */
	limit: number;
	/** Resolved result field names (never undefined by the time it reaches the engine). */
	fields: string[];
}

export interface EngineSearchResult {
	totalCards: number;
	/** Row objects keyed by result field name. */
	cards: Record<string, unknown>[];
}

export interface EngineCatalog {
	/** Card type → count, as the engine reports it (pre-alias massaging). */
	types: Record<string, number>;
	keywords: Record<string, number>;
}

/** What the routes need from a loaded engine instance. */
export interface Engine {
	search(opts: EngineSearchOptions): EngineSearchResult;
	commonCardTypes(): Record<string, number>;
	commonCardKeywords(): Record<string, number>;
	/** Random preferred-printing sample, mirroring upstream sample_preferred(). */
	samplePreferred(numCards: number, fields: string[]): Record<string, unknown>[];
	/** Number of cards in the store; 0 means "not loaded" upstream — here a loaded engine is never empty. */
	size(): number;
}

/**
 * Thrown when the engine cannot answer. Routes translate this to a loud
 * structured error — NEVER an empty result (upstream would fall back to SQL
 * here; this deployment has no SQL by design).
 */
export class EngineUnavailableError extends Error {
	constructor(
		message: string,
		/** True while the store is still being built/bootstrapped. */
		public readonly bootstrapping: boolean,
	) {
		super(message);
		this.name = "EngineUnavailableError";
	}
}

export interface StoreManifest {
	store_key: string;
	built_at: string;
	card_count: number;
	printing_count: number;
	upstream_commit: string;
	format_version: number;
}

export interface Env {
	STORE: R2Bucket;
	IMPORT_COORDINATOR: DurableObjectNamespace;
	R2_BUCKET: string;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	CF_ACCOUNT_ID: string;
}
