// The deploy side of backlog x3 — the fence, the upload lease, the sweep by role and the byte guard
// — written against a small KV interface so the same code runs over wrangler (kv-prune.ts's
// wranglerDeployKv, from seed-remote-kv.ts / prune-kv.ts / deploy-fence.ts) and over the import
// harness's in-memory KV (scripts/import-harness/failover.ts scenarios 5–7).
//
// THE DEPLOY WINS. import-store.sh writes the fence before it builds; every nightly run that began
// before it retires at its next alarm or its next write (ImportCoordinator.supersededBy). The deploy
// then takes the upload lease from whoever holds it and deletes every generation that plays no role —
// including the nightly's half-uploaded family — before its own first key, so KV never holds more
// than the live family, the one it replaced, and the deploy's.
//
// EVERY LIVE MANIFEST, NOT ONE (x19): the roles come from every per-format manifest and the legacy
// mirror (readPublishedManifests). A deploy that bumps the archive format publishes beside the
// running build's manifest, and both families are live until code reading the new format retires
// the old one — which a deploy never does: it runs BEFORE `wrangler deploy`, so it cannot know the
// switch will happen (kv-retention.ts, planFormatRetirement).

import {
	DEPLOY_FENCE_KEY,
	DEPLOY_FENCE_SETTLE_MS,
	DEPLOY_LEASE_OWNER,
	DEPLOY_LEASE_TTL_SECONDS,
	type DeployFence,
	describePlan,
	encodeUploadLease,
	GENERATION_KEY_PREFIX,
	kvBytesMetadata,
	type ListedKey,
	liveManifestRoles,
	type ManifestRoles,
	type PublishedManifest,
	parseDeployFence,
	parseUploadLease,
	planRetention,
	type RetentionPlan,
	withOwnManifest,
} from "../src/engine/kv-retention";
import {
	FORMAT_MANIFEST_PREFIX,
	formatManifestKey,
	formatOfManifestKey,
	MANIFEST_KEY,
	PUBLISHING_KEY,
} from "../src/engine/store-kv";

/** The KV calls the deploy side makes. A failed read is `failed`, never a miss (see kvGetText). */
export interface DeployKv {
	get(key: string): Promise<{ value: string | null; failed: string | null }>;
	put(key: string, value: string, opts?: { ttlSeconds?: number; metadata?: unknown }): Promise<void>;
	/** Every key under `prefix` ("" = the whole namespace) with its metadata, or null when the list failed. */
	list(prefix: string): Promise<ListedKey[] | null>;
	/** True when every key is gone. */
	deleteKeys(keys: readonly string[]): Promise<boolean>;
	sleep(ms: number): Promise<void>;
	now(): number;
}

/**
 * A fence older than this is not trusted to cover every run: the upload writes a fresh one and
 * waits it out (DEPLOY_FENCE_SETTLE_MS) before it takes the lease.
 *
 * The fence retires runs that STARTED before it; a run that started after it is protected only by
 * the lease, and a lease it has not yet seen (KV's 60 seconds) cannot protect it. So the fence must
 * be younger than the fastest a run gets from its start to its family's first key — the dumps'
 * download and the whole transform, tens of minutes in production — and then no run the fence
 * spares can already be uploading. import-store.sh's fence is usually minutes old by upload time;
 * a slow build costs one more fence and a minute's wait, never a race.
 */
export const DEPLOY_FENCE_FRESH_MS = 10 * 60_000;

/** Write the fence now — import-store.sh, before `cargo build`. */
export async function writeDeployFence(kv: DeployKv): Promise<DeployFence> {
	const fence: DeployFence = { at: kv.now() };
	const json = JSON.stringify(fence);
	await kv.put(DEPLOY_FENCE_KEY, json, { metadata: kvBytesMetadata(json.length) });
	return fence;
}

function parseManifest<M extends ManifestRoles = ManifestRoles>(text: string | null): M | null {
	if (!text) return null;
	try {
		const v = JSON.parse(text.slice(text.indexOf("{"))) as M;
		return v?.built_at ? v : null;
	} catch {
		return null;
	}
}

/**
 * Every live manifest (x19): the legacy mirror, and every `store:manifest:v<fmt>` a list of the
 * prefix shows. `failed` when any read or the list did not answer — callers then decide nothing,
 * exactly as they did when the one manifest read failed.
 *
 * One list and one get per format (normally one or two) — against the free plan's 1,000 lists and
 * 100,000 reads a day, from a deploy that runs this at most three times.
 *
 * A list can lag a key put within the last minute. The per-format keys have stable names, so that
 * only matters for the FIRST publish of a new format — the format-bump deploy itself, which holds
 * the upload lease and the fence over every other writer while it publishes.
 */
export async function readPublishedManifests<M extends ManifestRoles = ManifestRoles>(
	kv: DeployKv,
): Promise<{ published: PublishedManifest<M>[]; failed: string | null }> {
	const legacy = await kv.get(MANIFEST_KEY);
	if (legacy.failed) return { published: [], failed: `the legacy manifest: ${legacy.failed}` };
	const listed = await kv.list(FORMAT_MANIFEST_PREFIX);
	if (listed === null) return { published: [], failed: `the list of ${FORMAT_MANIFEST_PREFIX}*` };
	const published: PublishedManifest<M>[] = [];
	const legacyManifest = parseManifest<M>(legacy.value);
	if (legacyManifest) published.push({ key: MANIFEST_KEY, legacy: true, manifest: legacyManifest });
	for (const key of listed.map((k) => k.name).filter((name) => formatOfManifestKey(name) !== null)) {
		const read = await kv.get(key);
		if (read.failed) return { published: [], failed: `${key}: ${read.failed}` };
		const manifest = parseManifest<M>(read.value);
		if (manifest) published.push({ key, legacy: false, manifest });
	}
	return { published, failed: null };
}

/**
 * THE MIGRATION FROM THE SINGLE KEY (x19): make sure this build's own format has its per-format
 * manifest before `wrangler deploy` switches to code that reads it. When `store:manifest:v<format>`
 * is absent and the legacy key holds that same format, the legacy manifest is copied there — one
 * read on every later deploy, one write once. The legacy key is not touched: the build still
 * serving reads it until the switch.
 *
 * Not load-bearing on its own — readManifest falls back to a same-format legacy manifest while the
 * per-format key is absent — but it takes that fallback's second read off the steady state from the
 * first deploy on. A different format in the legacy key is left alone: that store is not this
 * build's, and a format-bump deploy publishes its own manifest before this matters.
 */
export async function ensureFormatManifest(
	kv: DeployKv,
	format: number,
): Promise<"present" | "copied" | "absent" | "other-format" | "failed"> {
	const own = await kv.get(formatManifestKey(format));
	if (own.failed) return "failed";
	if (parseManifest(own.value)) return "present";
	const legacy = await kv.get(MANIFEST_KEY);
	if (legacy.failed) return "failed";
	const manifest = parseManifest(legacy.value);
	if (!manifest) return "absent";
	if (manifest.format_version !== format) return "other-format";
	const json = JSON.stringify(manifest);
	await kv.put(formatManifestKey(format), json, { metadata: kvBytesMetadata(json.length) });
	return "copied";
}

export type BeginResult =
	| { ok: true; plan: RetentionPlan | null; fence: DeployFence }
	| { ok: false; why: string; plan: RetentionPlan };

/**
 * Before the deploy's first key: make sure a settled fence stands in front of every nightly run,
 * take the lease, sweep by role, and ask the byte guard about `incomingBytes` (the deploy's family,
 * EXACT — it is already cut and compressed in memory).
 *
 * A read or list that fails skips the sweep and the guard (warned): an upload over the cap fails
 * loudly at its put, where deleting on a half-read namespace is the 2026-09-15 shape.
 */
export async function beginDeployUpload(
	kv: DeployKv,
	opts: { builtAt: string; incomingBytes: number; limit?: number },
): Promise<BeginResult> {
	const read = await kv.get(DEPLOY_FENCE_KEY);
	let fence = read.failed ? null : parseDeployFence(read.value);
	if (!fence || kv.now() - fence.at > DEPLOY_FENCE_FRESH_MS) {
		fence = await writeDeployFence(kv);
		console.log(
			`  deploy fence written at ${new Date(fence.at).toISOString()} (none younger than ${DEPLOY_FENCE_FRESH_MS / 60_000}min was found)`,
		);
	}
	const settle = fence.at + DEPLOY_FENCE_SETTLE_MS - kv.now();
	if (settle > 0) {
		console.log(`  waiting ${Math.ceil(settle / 1000)}s for the deploy fence to reach every colo`);
		await kv.sleep(settle);
	}

	const held = await kv.get(PUBLISHING_KEY);
	const holder = held.failed ? null : parseUploadLease(held.value);
	if (holder && holder.built_at !== opts.builtAt) {
		console.log(
			`  taking the upload lease from ${holder.owner || "a pre-x3 run"} (build ${holder.built_at}); ` +
				"the deploy wins, and that run retires at its next alarm",
		);
	}
	const lease = encodeUploadLease({ built_at: opts.builtAt, owner: DEPLOY_LEASE_OWNER, epoch: fence.at });
	await kv.put(PUBLISHING_KEY, lease, {
		ttlSeconds: DEPLOY_LEASE_TTL_SECONDS,
		metadata: kvBytesMetadata(lease.length),
	});

	const manifests = await readPublishedManifests(kv);
	const keys = manifests.failed ? null : await kv.list("");
	if (manifests.failed || keys === null) {
		console.warn(
			`  Retention: could not read the ${manifests.failed ? `live manifests (${manifests.failed})` : "key list"} — no ` +
				"sweep and no byte guard this time; an upload over the cap fails at its put.",
		);
		return { ok: true, plan: null, fence };
	}
	// Every live format's family stays and is counted — the running build's AND, on a format bump,
	// nothing of the new one yet (it is the in-flight family).
	const { primary, others } = liveManifestRoles(manifests.published);
	const plan = planRetention(keys, {
		live: primary,
		otherLive: others,
		inFlight: opts.builtAt,
		incomingBytes: opts.incomingBytes,
		limit: opts.limit,
	});
	console.log(`  KV retention before the deploy's first key: ${describePlan(plan)}`);
	if (plan.decision === "drop-rollback") console.warn("  KV byte guard: dropping the rollback generation to fit");
	if (plan.retire.length > 0 && !(await kv.deleteKeys(plan.retire))) {
		console.warn(`  Retention: could not delete ${plan.retire.length} key(s); the upload goes ahead`);
	} else if (plan.retire.length > 0) {
		console.log(`  Retention: dropped ${plan.retire.length} key(s) before the upload`);
	}
	// A refusal still leaves the no-role families deleted above: space back, and nothing to lose.
	if (plan.decision === "refuse") {
		await releaseDeployLease(kv, opts.builtAt);
		return {
			ok: false,
			plan,
			why:
				`KV byte guard: ${(plan.projectedBytes / 1_000_000).toFixed(1)}MB projected with this build even without ` +
				"the rollback generation — refusing to upload a store that would cross the free plan's 1GB part way through",
		};
	}
	return { ok: true, plan, fence };
}

/**
 * Right before the deploy's manifest: does the lease still name this build? Only another DEPLOY can
 * take it from one (decideUploadLease), and that deploy has already deleted this build's family —
 * a manifest written now would name chunks that are gone. An ABSENT lease answers no too: this
 * deploy put it minutes ago with a two-hour TTL, so absent means that deploy has since released it
 * after its own manifest. A read that fails answers yes, which is what the deploy did before the
 * lease existed.
 */
export async function deployStillHoldsLease(kv: DeployKv, builtAt: string): Promise<boolean> {
	const held = await kv.get(PUBLISHING_KEY);
	if (held.failed) return true;
	return parseUploadLease(held.value)?.built_at === builtAt;
}

/** Compare-and-delete: only while the lease still names this deploy's build. */
export async function releaseDeployLease(kv: DeployKv, builtAt: string): Promise<void> {
	const held = await kv.get(PUBLISHING_KEY);
	if (held.failed || held.value === null) return;
	const lease = parseUploadLease(held.value);
	if (lease?.built_at !== builtAt) return;
	await kv.deleteKeys([PUBLISHING_KEY]);
}

/**
 * Retention by role, no guard: keep every live family (every live manifest's, `live` among them),
 * the one the newest format's manifest replaced, and the lease holder's; delete every other
 * generation key. Returns the keys deleted, or null when a read failed and nothing was touched.
 *
 * `live` is passed by the publisher that just wrote it — a fresh read of the key it just put may
 * still answer with the old manifest, and that answer would make the new build look like debris.
 * It replaces whatever its own format's key read as; the other formats' manifests are read.
 */
export async function sweepGenerationsByRole(kv: DeployKv, live?: ManifestRoles): Promise<number | null> {
	const manifests = await readPublishedManifests(kv);
	if (manifests.failed) return null;
	const published = live
		? withOwnManifest(manifests.published, formatManifestKey(Number(live.format_version)), live)
		: manifests.published;
	const { primary, others } = liveManifestRoles(published);
	if (!primary) {
		console.log("Retention: no readable manifest — leaving every store generation in place.");
		return 0;
	}
	const held = await kv.get(PUBLISHING_KEY);
	if (held.failed) return null;
	const lease = parseUploadLease(held.value);
	const keys = await kv.list(GENERATION_KEY_PREFIX);
	if (keys === null) return null;
	const liveAts = new Set([primary, ...others].map((m) => String(m.built_at)));
	const inFlight = lease && !liveAts.has(lease.built_at) ? lease.built_at : null;
	const plan = planRetention(keys, { live: primary, otherLive: others, inFlight });
	console.log(`Retention by role: ${describePlan(plan)}`);
	if (plan.retire.length === 0) return 0;
	return (await kv.deleteKeys(plan.retire)) ? plan.retire.length : 0;
}

/** After the deploy's manifest: release the lease, then sweep with the new roles. */
export async function finishDeployUpload(kv: DeployKv, published: ManifestRoles): Promise<number | null> {
	await releaseDeployLease(kv, String(published.built_at));
	return sweepGenerationsByRole(kv, published);
}
