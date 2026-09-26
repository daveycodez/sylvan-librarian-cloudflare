/**
 * Never more than three store generations in KV (backlog x3): retention BY ROLE, one upload
 * lease, the deploy's fence, and a byte guard in front of every new family.
 *
 * ── WHY ROLES AND NOT AGE ────────────────────────────────────────────────────
 *
 * Retention used to keep "the newest KEEP_STORES_IN_KV=2 builds by built_at, plus whatever is
 * protected". A run that was superseded half way through its upload leaves a family with a NEWER
 * built_at than the live one, so it survived the sweep and pushed the rollback generation out
 * instead; a second overlapping run made four. On 2026-09-24 the free account held four. At 2x the
 * corpus, three generations during an upload are 98% of the free plan's 1 GB of KV, four are 128%.
 *
 * So a family is kept for the ROLE it plays, never for its age, and there are exactly three:
 *
 *   live      the family the live manifest names
 *   rollback  the family that manifest replaced (`previous_built_at`, written by every publisher)
 *   inFlight  the family of the one upload-lease holder (PUBLISHING_KEY)
 *
 * Everything else under GENERATION_KEY_PREFIX is deleted. The rollback is dropped too — only — when
 * the byte guard says the next family would not fit beside it (decideByteGuard).
 *
 * ── TWO LIVE FAMILIES, ONE PER ARCHIVE FORMAT (backlog x19) ─────────────────
 *
 * A reader reads the manifest of its own archive format (`store:manifest:v<fmt>`, store-kv.ts), so
 * a deploy that bumps the format publishes beside the running build instead of over it, and for the
 * minutes until `wrangler deploy` switches the code — and until the next publish by the new code —
 * TWO manifests are live. Both are the LIVE role: `live` is the newest format's (the primary, whose
 * `previous_built_at` names the rollback), `otherLive` every other family a live manifest or the
 * legacy mirror names. Neither the sweep nor the byte guard ever deletes a live family; a guard that
 * cannot fit the new family beside both refuses it.
 *
 * STILL AT MOST THREE: the rollback is kept only while live + in flight + rollback is three families
 * or fewer. In the usual overlap it costs nothing — the new format's rollback IS the old format's
 * live family — and the old format stops being live at the next publish by code that reads the new
 * one (planFormatRetirement), when it becomes that rollback and then goes a publish later.
 *
 * ── WHAT A FAMILY IS ─────────────────────────────────────────────────────────
 *
 * Every key named `store:card-<kind>-v<fmt>-<built_at>[-p<k>][.<ext>[:<n>]]` belongs to the family
 * of its built_at: the chunk families (`card-store`), the routing filter (`card-routing`), the tag
 * alias map (`card-aliases`), and ANY FUTURE per-generation kind with no change here — name it
 * with `generationKey(kind, …)`. Keys outside the prefix (rulings, reference data, the oracle
 * index, `engine:live:*`, the manifest, the lease, the pointers) are stable keys overwritten in
 * place; retention never deletes one, and the byte guard counts every one of them.
 *
 * Pure functions only — the coordinator, scripts/seed-remote-kv.ts, the prune scripts and the
 * import harness all decide through these, so the three writers cannot disagree.
 */

import type { StoreManifest } from "./types";

/** Every per-generation key lives under this prefix, and only per-generation keys do. */
export const GENERATION_KEY_PREFIX = "store:card-";

const GENERATION_KEY_RE = /^store:card-([a-z][a-z0-9]*)-v(\d+)-(\d+)(?:-p\d+)?(?:\.[a-z0-9]+(?::\d+)?)?$/;

/** The built_at a key's family is keyed by, or null for a key that belongs to no generation. */
export function generationOfKey(name: string): string | null {
	return GENERATION_KEY_RE.exec(name)?.[3] ?? null;
}

/**
 * A one-value per-generation key of `kind` (`store:card-<kind>-v<fmt>-<built_at>.store:0`) — the
 * shape the routing filter and the tag alias map already have. A new per-generation value named
 * through this is inside its generation's family, so retention keeps and retires it with the
 * archives it describes and no second sweep exists to be forgotten.
 */
export function generationKey(kind: string, formatVersion: number, builtAt: string): string {
	if (!/^[a-z][a-z0-9]*$/.test(kind))
		throw new Error(`generation key kind ${JSON.stringify(kind)} is not [a-z][a-z0-9]*`);
	return `${GENERATION_KEY_PREFIX}${kind}-v${formatVersion}-${builtAt}.store:0`;
}

// ── roles ─────────────────────────────────────────────────────────────────────

export interface RetentionRoles {
	/** The live manifest's built_at. Null means no readable manifest: nothing is deleted at all. */
	live: string | null;
	/**
	 * Every OTHER family a live manifest names (x19): another archive format's, or the legacy mirror's
	 * while it lags. Kept exactly like `live` — a deployed build may be reading it.
	 */
	otherLive?: string[];
	/** The family the live manifest replaced, or null when there is none or the byte guard dropped it. */
	rollback: string | null;
	/** The upload-lease holder's built_at, or null when nothing is uploading. */
	inFlight: string | null;
}

/** The families retention keeps: at most three, by construction. */
export function retainedFamilies(roles: RetentionRoles): Set<string> {
	const kept = new Set<string>();
	for (const builtAt of [roles.live, ...(roles.otherLive ?? []), roles.rollback, roles.inFlight]) {
		if (builtAt) kept.add(builtAt);
	}
	return kept;
}

/** Every generation present among `names`, newest first. */
export function generationsPresent(names: Iterable<string>): string[] {
	const found = new Set<string>();
	for (const name of names) {
		const at = generationOfKey(name);
		if (at) found.add(at);
	}
	return [...found].sort((a, b) => Number(b) - Number(a));
}

/**
 * The keys retention deletes: every generation key whose family plays no role.
 *
 * NOTHING when there is no live manifest: with no manifest there is no way to tell the store
 * readers need from debris, and sweeping could delete the only store there is.
 */
export function keysToRetire(names: Iterable<string>, roles: RetentionRoles): string[] {
	if (!roles.live) return [];
	const kept = retainedFamilies(roles);
	const out: string[] = [];
	for (const name of names) {
		const at = generationOfKey(name);
		if (at && !kept.has(at)) out.push(name);
	}
	return out;
}

/** What retention needs from a manifest; every publisher's manifest has it. */
export type ManifestRoles = Pick<StoreManifest, "built_at"> &
	Partial<Pick<StoreManifest, "previous_built_at" | "partitions" | "store_gzip_bytes" | "format_version">>;

/**
 * The rollback role for `live`: the family it replaced.
 *
 * `previous_built_at` when the manifest carries it. A manifest from before x3 does not, and then
 * the rollback is the newest family present that is OLDER than the live one and is not the
 * in-flight upload — never a newer one, which is exactly the superseded run's orphan that used to
 * displace the real rollback.
 */
export function rollbackFor(
	live: ManifestRoles | null,
	present: Iterable<string>,
	inFlight: string | null = null,
	otherLive: readonly string[] = [],
): string | null {
	if (!live?.built_at) return null;
	const liveAt = String(live.built_at);
	if (live.previous_built_at) {
		const prev = String(live.previous_built_at);
		return prev === liveAt ? null : prev;
	}
	for (const at of generationsPresent(present)) {
		if (at !== inFlight && !otherLive.includes(at) && Number(at) < Number(liveAt)) return at;
	}
	return null;
}

/**
 * `next` stamped with the built_at of the manifest it replaces — the rollback role's record.
 *
 * Republishing the SAME build keeps the live manifest's own `previous_built_at`, so a retried
 * publish never makes a family its own rollback and loses the real one.
 */
export function withPreviousBuiltAt<M extends { built_at: string; previous_built_at?: string }>(
	next: M,
	live: { built_at?: unknown; previous_built_at?: unknown } | null,
): M {
	const liveAt = live?.built_at !== undefined && live.built_at !== null ? String(live.built_at) : "";
	const out = { ...next };
	if (!liveAt) {
		delete out.previous_built_at;
	} else if (liveAt !== String(next.built_at)) {
		out.previous_built_at = liveAt;
	} else if (live?.previous_built_at) {
		out.previous_built_at = String(live.previous_built_at);
	} else {
		delete out.previous_built_at;
	}
	return out;
}

// ── the live manifests, one per archive format (x19) ──────────────────────────

/** A manifest as found in KV: a per-format key (`store:manifest:v<fmt>`) or the legacy mirror. */
export interface PublishedManifest<M extends ManifestRoles = ManifestRoles> {
	key: string;
	/** True for the legacy mirror (`store:manifest`), which pre-x19 builds read. */
	legacy: boolean;
	manifest: M;
}

/**
 * The roles the live manifests give: `primary` is the newest archive format's (its
 * `previous_built_at` is THE rollback), `others` every other family a live manifest names. Every
 * writer decides from this, so they agree on which family is which whatever order KV lists them in.
 * Pure.
 */
export function liveManifestRoles<M extends ManifestRoles>(
	published: readonly PublishedManifest<M>[],
): { primary: M | null; others: M[] } {
	const usable = published.filter((p) => p.manifest?.built_at);
	const fmt = (p: PublishedManifest<M>) => Number(p.manifest.format_version ?? 0) || 0;
	const sorted = [...usable].sort(
		(a, b) =>
			fmt(b) - fmt(a) ||
			Number(a.legacy) - Number(b.legacy) ||
			Number(b.manifest.built_at) - Number(a.manifest.built_at),
	);
	const primary = sorted[0]?.manifest ?? null;
	const seen = new Set<string>(primary ? [String(primary.built_at)] : []);
	const others: M[] = [];
	for (const p of sorted.slice(1)) {
		const at = String(p.manifest.built_at);
		if (seen.has(at)) continue;
		seen.add(at);
		others.push(p.manifest);
	}
	return { primary, others };
}

/**
 * The manifest a publish of `format` REPLACES — its rollback (previous_built_at) and the source of
 * the blocks it carries forward (carryManifestBlocks): its own format's manifest when there is one,
 * else the newest live manifest of any format, so a format bump's rollback is the family the
 * running build serves. Pure.
 */
export function replacedManifest<M extends ManifestRoles>(
	published: readonly PublishedManifest<M>[],
	format: number,
): M | null {
	const own = published.find((p) => !p.legacy && p.manifest?.format_version === format);
	return own ? own.manifest : liveManifestRoles(published).primary;
}

export interface FormatRetirement<M extends ManifestRoles = ManifestRoles> {
	/** Per-format manifest keys of OLDER formats, to delete. */
	retireKeys: string[];
	/** What the legacy mirror should hold now (the retiring code's own manifest), or null to leave it. */
	legacyTo: M | null;
}

/**
 * Which older formats stop being live, decided by code of archive `format` that is RUNNING DEPLOYED
 * — the nightly coordinator, and nothing in a deploy's build, which runs before `wrangler deploy`
 * and cannot tell whether the switch will happen.
 *
 * Every per-format manifest of a LOWER format is retired, and the legacy mirror moves forward to
 * this format's manifest if it held a lower one: no deployed reader reads them once this code
 * runs. Nothing happens unless this format's own manifest exists (a build with no store of its own
 * keeps the old one, which is then still the rollback's code), and a HIGHER format is never
 * touched — its deploy may be half way through. The retired family stays in KV while it is the new
 * manifest's rollback (the usual case), and goes at the publish after. Pure.
 */
export function planFormatRetirement<M extends ManifestRoles>(
	published: readonly PublishedManifest<M>[],
	format: number,
): FormatRetirement<M> {
	const own = published.find((p) => !p.legacy && p.manifest?.format_version === format)?.manifest;
	if (!own) return { retireKeys: [], legacyTo: null };
	const lower = (p: PublishedManifest<M>) => Number(p.manifest?.format_version ?? 0) < format;
	const retireKeys = published.filter((p) => !p.legacy && lower(p)).map((p) => p.key);
	const legacy = published.find((p) => p.legacy);
	const legacyTo = !legacy || lower(legacy) ? own : null;
	return { retireKeys, legacyTo };
}

/**
 * `published` with `manifest` as the entry at `key` (its own format's key) — a publisher's
 * just-written manifest, which a read straight after the put may still answer with the old one. Pure.
 */
export function withOwnManifest<M extends ManifestRoles>(
	published: readonly PublishedManifest<M>[],
	key: string,
	manifest: M,
): PublishedManifest<M>[] {
	return [...published.filter((p) => p.key !== key), { key, legacy: false, manifest }];
}

/** `published` as it stands once `retirement` has been carried out. Pure. */
export function afterFormatRetirement<M extends ManifestRoles>(
	published: readonly PublishedManifest<M>[],
	retirement: FormatRetirement<M>,
	legacyKey: string,
): PublishedManifest<M>[] {
	const out = published.filter((p) => !p.legacy && !retirement.retireKeys.includes(p.key));
	const legacy = published.find((p) => p.legacy);
	if (retirement.legacyTo) out.push({ key: legacyKey, legacy: true, manifest: retirement.legacyTo });
	else if (legacy) out.push(legacy);
	return out;
}

// ── the upload lease ──────────────────────────────────────────────────────────

/**
 * The one family allowed to be uploading (PUBLISHING_KEY's value).
 *
 * `owner` is the coordinator's name, or DEPLOY_LEASE_OWNER; `epoch` is the coordinator's
 * designation epoch (import-watchdog.ts), or the deploy fence's time. A value written before x3 is a
 * bare built_at and parses with owner "" and epoch -1, so any claimant outranks it.
 */
export interface UploadLease {
	built_at: string;
	owner: string;
	epoch: number;
}

/** The owner a deploy's lease carries. A deploy takes the lease from anyone; only a deploy takes it from one. */
export const DEPLOY_LEASE_OWNER = "deploy";
/**
 * A deploy's lease lives this long unreleased: a deploy that died mid-upload must not keep the
 * nightly waiting for the coordinator lease's full week. Workers Builds gives a build 20 minutes.
 */
export const DEPLOY_LEASE_TTL_SECONDS = 2 * 3600;

/**
 * Parses the binding's value and `wrangler kv key get`'s stdout alike: the JSON object is taken from
 * its first `{`, and a bare built_at from the last line, so a banner line in front changes nothing.
 * A value that parses to nothing is null — which the deploy's manifest check reads as "not ours", so
 * this must not be stricter than the values this repo writes.
 */
export function parseUploadLease(raw: string | null | undefined): UploadLease | null {
	if (raw === null || raw === undefined) return null;
	const text = raw.trim();
	if (!text) return null;
	const brace = text.indexOf("{");
	if (brace !== -1) {
		try {
			const v = JSON.parse(text.slice(brace, text.lastIndexOf("}") + 1)) as Partial<UploadLease>;
			const at = v.built_at !== undefined && v.built_at !== null ? String(v.built_at) : "";
			if (!/^\d+$/.test(at)) return null;
			return {
				built_at: at,
				owner: typeof v.owner === "string" ? v.owner : "",
				epoch: typeof v.epoch === "number" && Number.isFinite(v.epoch) ? v.epoch : -1,
			};
		} catch {
			return null;
		}
	}
	const legacy = /(?:^|\n)\s*(\d+)$/.exec(text)?.[1];
	return legacy ? { built_at: legacy, owner: "", epoch: -1 } : null;
}

export function encodeUploadLease(lease: UploadLease): string {
	return JSON.stringify({ built_at: lease.built_at, owner: lease.owner, epoch: lease.epoch });
}

export type LeaseDecision =
	| { kind: "take"; displaced: UploadLease | null }
	| { kind: "yield"; holder: UploadLease; why: string };

/**
 * May `claim` take the upload lease from `held`?
 *
 * Taken over ONLY by the same family (a refresh), by the deploy path, by a later run of the same
 * owner (the earlier run's lease leaked), or by a HIGHER epoch — the coordinator the watchdog
 * designated after the holder's. A coordinator never takes it from a deploy: it waits for the
 * deploy's release or its two-hour TTL.
 */
export function decideUploadLease(held: UploadLease | null, claim: UploadLease): LeaseDecision {
	if (!held || held.built_at === claim.built_at) return { kind: "take", displaced: null };
	if (claim.owner === DEPLOY_LEASE_OWNER) return { kind: "take", displaced: held };
	if (held.owner === DEPLOY_LEASE_OWNER) {
		return { kind: "yield", holder: held, why: `a deploy is uploading build ${held.built_at}` };
	}
	if (held.owner !== "" && held.owner === claim.owner) return { kind: "take", displaced: held };
	if (claim.epoch > held.epoch) return { kind: "take", displaced: held };
	return {
		kind: "yield",
		holder: held,
		why: `${held.owner || "an older run"} (epoch ${held.epoch}) holds the lease for build ${held.built_at}`,
	};
}

// ── the deploy fence ──────────────────────────────────────────────────────────

/**
 * Written by scripts/import-store.sh before it builds a store: every nightly run STARTED before it
 * retires (it publishes nothing), and the deploy then owns the upload. Two writers on one KV are how
 * the site went dark twice; the deploy is the one a human is watching, so the deploy wins.
 */
export const DEPLOY_FENCE_KEY = "import:deploy-fence";
/**
 * How old the fence must be before the deploy deletes another run's family: KV takes up to 60s to
 * show a write everywhere, and a coordinator must be able to SEE the fence before the family it is
 * uploading can vanish under it. The build between the fence and the upload is minutes; this only
 * waits when the upload is run by hand.
 */
export const DEPLOY_FENCE_SETTLE_MS = 65_000;

export interface DeployFence {
	/** When the deploy began (ms since the epoch). */
	at: number;
}

export function parseDeployFence(raw: unknown): DeployFence | null {
	const v = typeof raw === "string" ? safeJson(raw.slice(Math.max(0, raw.indexOf("{")))) : raw;
	if (!v || typeof v !== "object") return null;
	const at = (v as { at?: unknown }).at;
	return typeof at === "number" && Number.isFinite(at) && at > 0 ? { at } : null;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// ── the byte guard ────────────────────────────────────────────────────────────

/** The free plan's KV storage, per account (decimal, as Cloudflare meters it; 2^30 would only add room). */
export const KV_NAMESPACE_CAP_BYTES = 1_000_000_000;
/** Where the guard stops a new family: 5% under the cap, for what the estimate cannot see. */
export const KV_GUARD_BYTES = 950_000_000;
/**
 * The new family, projected from the live one: the coordinator gzips at CompressionStream's level
 * (~7% bigger than the deploy's -9), plus its routing filter and alias map. The deploy knows its
 * family's exact size and passes that instead.
 */
export const NEW_FAMILY_ALLOWANCE = 1.1;

/** Every value this repo puts carries its own size, so a `list` can sum the namespace. */
export function kvBytesMetadata(bytes: number): { b: number } {
	return { b: bytes };
}

/** A key from a KV `list` — the binding's and wrangler's shapes both fit. */
export interface ListedKey {
	name: string;
	metadata?: unknown;
}

/**
 * Sizes for a key written before every put carried `{b}` — measured on 2026-09-24 (report 15) with
 * room for growth, so the guard over-counts a legacy key rather than under-counts it. Each one is
 * replaced by the exact size the next time its key is written: a generation's keys within two
 * nights, the stable datasets whenever their bytes change.
 */
const LEGACY_ESTIMATES: readonly [prefix: string, bytes: number][] = [
	// A chunk the live manifest does not describe: the value cap, the most it can be.
	["store:card-store-", 26_214_400],
	["store:card-routing-", 4_194_304], // 1.74 MB at 1x
	[GENERATION_KEY_PREFIX, 1_048_576], // aliases 68 KB; any later kind
	["rulings:", 262_144], // 256 buckets, largest 164 KB
	["reference:", 262_144], // 38 values, 3.2 MB in all
	["oracle-index:", 655_360], // 64 buckets of ~272 KB, ~543 KB at 2x
];
/** Everything else is a small control value: the manifest, the lease, pointers, `engine:live:*`. */
const LEGACY_SMALL_BYTES = 16_384;

/** The chunk sizes the live manifest(s) record, for their own legacy chunks. */
export function manifestChunkSizes(live: ManifestRoles | null, ...others: ManifestRoles[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const p of [live, ...others].flatMap((m) => m?.partitions ?? [])) {
		if (!p.store_key || !p.chunk_count) continue;
		const per = Math.ceil((p.store_gzip_bytes ?? p.store_bytes) / p.chunk_count);
		for (let seq = 0; seq < p.chunk_count; seq++) out.set(`store:${p.store_key}:${seq}`, per);
	}
	return out;
}

/** One key's bytes: its `{b}` when it has one, else the best estimate (and says which). */
export function listedKeyBytes(
	key: ListedKey,
	known: Map<string, number> = new Map(),
): { bytes: number; exact: boolean } {
	const b = (key.metadata as { b?: unknown } | null | undefined)?.b;
	if (typeof b === "number" && Number.isFinite(b) && b >= 0) return { bytes: b, exact: true };
	const fromManifest = known.get(key.name);
	if (fromManifest !== undefined) return { bytes: fromManifest, exact: false };
	for (const [prefix, bytes] of LEGACY_ESTIMATES) if (key.name.startsWith(prefix)) return { bytes, exact: false };
	return { bytes: LEGACY_SMALL_BYTES, exact: false };
}

export type GuardDecision = "go" | "drop-rollback" | "refuse";

/**
 * Whether a new family of `incoming` bytes may start, given `used` (the namespace after the
 * sweep) of which `rollbackBytes` are the rollback family's.
 *
 * Decided BEFORE the family's first key: a refused upload leaves the site serving what it serves,
 * where puts failing half way through at the cap would leave debris and a failed run anyway.
 * Dropping the rollback costs only the manual "republish yesterday's manifest" option while near
 * the cap — at upload time the rollback is ~24 hours old and no reader is still streaming it.
 */
export function decideByteGuard(input: { used: number; rollbackBytes: number; incoming: number; limit?: number }): {
	decision: GuardDecision;
	projected: number;
} {
	const limit = input.limit ?? KV_GUARD_BYTES;
	const projected = input.used + input.incoming;
	if (projected <= limit) return { decision: "go", projected };
	const without = projected - input.rollbackBytes;
	if (input.rollbackBytes > 0 && without <= limit) return { decision: "drop-rollback", projected: without };
	return { decision: "refuse", projected: without };
}

// ── the plan every writer follows ─────────────────────────────────────────────

export interface FamilyInfo {
	builtAt: string;
	keys: number;
	bytes: number;
	/** "kept" is a family with no role that stays only because there is no manifest to judge by. */
	role: "live" | "rollback" | "inFlight" | "retired" | "kept";
}

export interface RetentionPlan {
	/** The roles after the guard: `rollback` is null when it was dropped. */
	roles: RetentionRoles;
	/** Keys to delete, orphans first and then (when dropped) the rollback. */
	retire: string[];
	/** The guard's decision; "sweep" when no family is about to start (no guard ran). */
	decision: GuardDecision | "sweep";
	/** The namespace's bytes once `retire` is gone. */
	usedBytes: number;
	/** `usedBytes` plus the incoming family (equal to usedBytes for a sweep). */
	projectedBytes: number;
	/** Keys whose size is an estimate, not metadata. */
	estimatedKeys: number;
	families: FamilyInfo[];
}

/**
 * THE decision, for every writer: which families stay, which keys go, and whether a family of
 * `incomingBytes` may start. `keys` is a listing of the WHOLE namespace when a guard is wanted
 * (`incomingBytes` set), or at least of GENERATION_KEY_PREFIX for a sweep.
 */
export function planRetention(
	keys: readonly ListedKey[],
	opts: {
		live: ManifestRoles | null;
		/** x19: every other live manifest — another format's, the legacy mirror's (liveManifestRoles). */
		otherLive?: readonly ManifestRoles[];
		inFlight: string | null;
		incomingBytes?: number;
		limit?: number;
	},
): RetentionPlan {
	const names = keys.map((k) => k.name);
	const liveAt = opts.live?.built_at ? String(opts.live.built_at) : null;
	const others = (opts.otherLive ?? []).filter((m) => m?.built_at);
	// With no primary there is no manifest to judge by, and nothing is deleted — whatever else is live.
	const otherLive = liveAt ? [...new Set(others.map((m) => String(m.built_at)))].filter((at) => at !== liveAt) : [];
	const roles: RetentionRoles = {
		live: liveAt,
		otherLive,
		rollback: rollbackFor(opts.live, names, opts.inFlight, otherLive),
		inFlight: opts.inFlight,
	};
	if (
		roles.rollback &&
		(roles.rollback === roles.live || roles.rollback === roles.inFlight || otherLive.includes(roles.rollback))
	) {
		roles.rollback = null;
	}
	// Three families at most: with two formats live and an upload in flight, the rollback goes first.
	if (roles.rollback && new Set([liveAt, ...otherLive, roles.inFlight, roles.rollback].filter(Boolean)).size > 3) {
		roles.rollback = null;
	}
	const known = manifestChunkSizes(opts.live, ...others);
	const perFamily = new Map<string, { keys: string[]; bytes: number }>();
	let total = 0;
	let estimatedKeys = 0;
	for (const key of keys) {
		const { bytes, exact } = listedKeyBytes(key, known);
		total += bytes;
		if (!exact) estimatedKeys += 1;
		const at = generationOfKey(key.name);
		if (!at) continue;
		const fam = perFamily.get(at) ?? { keys: [], bytes: 0 };
		fam.keys.push(key.name);
		fam.bytes += bytes;
		perFamily.set(at, fam);
	}
	const kept = retainedFamilies(roles);
	const retire: string[] = [];
	let used = total;
	if (roles.live) {
		for (const [at, fam] of perFamily) {
			if (kept.has(at)) continue;
			retire.push(...fam.keys);
			used -= fam.bytes;
		}
	}
	let decision: RetentionPlan["decision"] = "sweep";
	let projected = used;
	if (opts.incomingBytes !== undefined) {
		const rollbackBytes = roles.rollback ? (perFamily.get(roles.rollback)?.bytes ?? 0) : 0;
		const guard = decideByteGuard({ used, rollbackBytes, incoming: opts.incomingBytes, limit: opts.limit });
		decision = guard.decision;
		projected = guard.projected;
		if (guard.decision === "drop-rollback" && roles.rollback) {
			retire.push(...(perFamily.get(roles.rollback)?.keys ?? []));
			used -= rollbackBytes;
			roles.rollback = null;
		}
	}
	const families: FamilyInfo[] = [...perFamily]
		.sort(([a], [b]) => Number(b) - Number(a))
		.map(([builtAt, fam]) => ({
			builtAt,
			keys: fam.keys.length,
			bytes: fam.bytes,
			role:
				builtAt === roles.live || otherLive.includes(builtAt)
					? "live"
					: builtAt === roles.inFlight
						? "inFlight"
						: builtAt === roles.rollback
							? "rollback"
							: roles.live
								? "retired"
								: "kept",
		}));
	return { roles, retire, decision, usedBytes: used, projectedBytes: projected, estimatedKeys, families };
}

/** One log line for a plan. */
export function describePlan(plan: RetentionPlan): string {
	const mb = (n: number) => `${(n / 1_000_000).toFixed(1)}MB`;
	const fams = plan.families.map((f) => `${f.builtAt}=${f.role}(${f.keys} keys, ${mb(f.bytes)})`).join(" ");
	return (
		`live ${plan.roles.live ?? "-"}` +
		(plan.roles.otherLive?.length ? ` (+ ${plan.roles.otherLive.join(", ")}, another format's)` : "") +
		`, rollback ${plan.roles.rollback ?? "-"}, in flight ${plan.roles.inFlight ?? "-"}; ` +
		`${plan.retire.length} key(s) to retire; ${mb(plan.usedBytes)} used after` +
		(plan.decision === "sweep" ? "" : `, ${mb(plan.projectedBytes)} projected with the new family → ${plan.decision}`) +
		(plan.estimatedKeys > 0 ? ` (${plan.estimatedKeys} key(s) sized by estimate)` : "") +
		(fams ? ` [${fams}]` : "")
	);
}
