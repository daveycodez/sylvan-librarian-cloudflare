// "Does remote KV already hold a current version of this dataset?"
//
// Both seeding scripts run in the deploy path, where they must be cheap and idempotent: the
// nightly import is what keeps rulings and reference data CURRENT, so a deploy only has to make
// sure they are THERE. Without this, every push would republish ~295 KV values against the free
// plan's 1,000 writes a day — the same reasoning that makes the store import skip when a recent
// store is already live.
//
// The probe is one `kv key get` of the dataset's meta key, which each publisher writes LAST for
// exactly this purpose: it is present only when a full set landed behind it.

import { kvTargetArgs } from "./kv-target";
import { wranglerArgv } from "./wrangler-cmd";

/**
 * Whether KV holds a meta key describing the format this build publishes.
 *
 * A missing key, an unreadable one, or one written by a different format version all answer false
 * — the caller then publishes, which is the safe direction: publishing over a current set costs
 * writes, and skipping over an absent one costs a 503 on every request until the next cron.
 */
export async function kvHasCurrent(key: string, formatVersion: number, remote: boolean): Promise<boolean> {
	const proc = Bun.spawn([...wranglerArgv(), "kv", "key", "get", key, ...(await kvTargetArgs(remote))], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) return false; // absent, or could not be read: publish either way
	try {
		// wrangler prints its own banner before the value; the JSON starts at the first brace.
		const meta = JSON.parse(out.slice(out.indexOf("{"))) as { format_version?: number };
		return meta.format_version === formatVersion;
	} catch {
		return false;
	}
}
