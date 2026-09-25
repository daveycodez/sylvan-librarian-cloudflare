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
	type ManifestRoles,
	parseDeployFence,
	parseUploadLease,
	planRetention,
	type RetentionPlan,
} from "../src/engine/kv-retention";
import { MANIFEST_KEY, PUBLISHING_KEY } from "../src/engine/store-kv";

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

function parseManifest(text: string | null): ManifestRoles | null {
	if (!text) return null;
	try {
		const v = JSON.parse(text.slice(text.indexOf("{"))) as ManifestRoles;
		return v?.built_at ? v : null;
	} catch {
		return null;
	}
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

	const manifest = await kv.get(MANIFEST_KEY);
	const keys = manifest.failed ? null : await kv.list("");
	if (manifest.failed || keys === null) {
		console.warn(
			`  Retention: could not read the ${manifest.failed ? "live manifest" : "key list"} — no sweep and no byte ` +
				"guard this time; an upload over the cap fails at its put.",
		);
		return { ok: true, plan: null, fence };
	}
	const plan = planRetention(keys, {
		live: parseManifest(manifest.value),
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
 * Retention by role, no guard: keep the live family (`live`, or the manifest read fresh), the one
 * it replaced, and the lease holder's; delete every other generation key. Returns the keys
 * deleted, or null when a read failed and nothing was touched.
 *
 * `live` is passed by the publisher that just wrote it — a fresh read of the key it just put may
 * still answer with the old manifest, and that answer would make the new build look like debris.
 */
export async function sweepGenerationsByRole(kv: DeployKv, live?: ManifestRoles): Promise<number | null> {
	let manifest: ManifestRoles | null | undefined = live;
	if (!manifest) {
		const read = await kv.get(MANIFEST_KEY);
		if (read.failed) return null;
		manifest = parseManifest(read.value);
	}
	if (!manifest) {
		console.log("Retention: no readable manifest — leaving every store generation in place.");
		return 0;
	}
	const held = await kv.get(PUBLISHING_KEY);
	if (held.failed) return null;
	const lease = parseUploadLease(held.value);
	const keys = await kv.list(GENERATION_KEY_PREFIX);
	if (keys === null) return null;
	const inFlight = lease && lease.built_at !== String(manifest.built_at) ? lease.built_at : null;
	const plan = planRetention(keys, { live: manifest, inFlight });
	console.log(`Retention by role: ${describePlan(plan)}`);
	if (plan.retire.length === 0) return 0;
	return (await kv.deleteKeys(plan.retire)) ? plan.retire.length : 0;
}

/** After the deploy's manifest: release the lease, then sweep with the new roles. */
export async function finishDeployUpload(kv: DeployKv, published: ManifestRoles): Promise<number | null> {
	await releaseDeployLease(kv, String(published.built_at));
	return sweepGenerationsByRole(kv, published);
}
