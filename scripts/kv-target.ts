// Which KV namespace a script's `wrangler kv` calls should hit.
//
// Remote reads and writes address the namespace BY ID, resolved from its title, rather than by
// binding name. That is what seed-remote-kv.ts has always done, and the reason is worth keeping in
// one place: a binding resolves through whatever wrangler.jsonc says at that moment, so a run
// racing align-kv-binding.ts — or one on a machine whose config was restored after a deploy — can
// address a namespace that is not the one being published to. An id cannot drift.
//
// Local is the opposite case: miniflare owns its own storage and there is no id to look up, so the
// binding IS the address there.

import { kvName } from "./project-config";
import { wranglerArgv } from "./wrangler-cmd";

let cachedId: string | null = null;

/** The id of the namespace align-kv-binding.ts created or pinned for this Worker. */
async function namespaceId(): Promise<string> {
	if (cachedId) return cachedId;
	const proc = Bun.spawn([...wranglerArgv(), "kv", "namespace", "list"], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	if ((await proc.exited) !== 0) {
		// Most often several accounts and no CLOUDFLARE_ACCOUNT_ID, which wrangler cannot resolve
		// non-interactively — say so, because the raw error does not.
		throw new Error(
			`cannot list KV namespaces (set CLOUDFLARE_ACCOUNT_ID if this account is one of several): ${
				err.trim() || out.trim() || "no output"
			}`,
		);
	}
	const all = JSON.parse(out.slice(out.indexOf("["))) as { id?: string; title?: string }[];
	const found = all.find((n) => n.title === kvName)?.id;
	if (!found) throw new Error(`no KV namespace named "${kvName}" — run scripts/align-kv-binding.ts first`);
	cachedId = found;
	return found;
}

/**
 * The `wrangler kv` arguments that select this deployment's namespace.
 *
 * `--remote` IS LOAD-BEARING and is the reason this helper exists. wrangler defaults these
 * commands to LOCAL storage, and it does so silently: `kv bulk put --namespace-id <production id>`
 * without it reports "Success!" having written to the miniflare state directory, and
 * `kv key list --namespace-id <production id>` answers from there too. A seeding run looked
 * perfect, the routes kept answering 503, and reading the namespace back "confirmed" data that was
 * only ever on this laptop. seed-remote-kv.ts has always passed it (`kv key put ... --remote`),
 * which is why the store publishes and nothing else did.
 */
export async function kvTargetArgs(remote: boolean): Promise<string[]> {
	return remote
		? ["--namespace-id", await namespaceId(), "--remote"]
		: ["--binding", "STORE_KV", "--local", "-c", "wrangler.dev.jsonc"];
}
