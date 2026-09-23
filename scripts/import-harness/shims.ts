// Runtime shims shared by the import harnesses (run.ts, failover.ts). Imported for its side
// effects, FIRST: the plugin has to be registered before anything imports the coordinator.

import { plugin } from "bun";

/** `WebAssembly.Module` is declared abstract in lib.dom; the committed wasm
 * tests construct it the same way (tests/import/canonical-wasm.test.ts). */
const WasmModule = WebAssembly.Module as unknown as new (bytes: ArrayBuffer) => WebAssembly.Module;

// ── the two things bun cannot resolve that workerd can ───────────────────────
//
// Registered BEFORE the coordinator is imported (hence the dynamic import
// below): `cloudflare:workers` is a runtime-provided module, and a `.wasm`
// import is a WebAssembly.Module under wrangler's CompiledWasm rule but a bare
// file path under bun. Both shims are load-time only — no behaviour of the
// code under test is replaced.
plugin({
	name: "workers-runtime-shims",
	setup(build) {
		build.module("cloudflare:workers", () => ({
			exports: {
				DurableObject: class {
					ctx: unknown;
					env: unknown;
					constructor(ctx: unknown, env: unknown) {
						this.ctx = ctx;
						this.env = env;
					}
				},
				WorkerEntrypoint: class {},
			},
			loader: "object",
		}));
		build.onLoad({ filter: /\.wasm$/ }, async (args) => ({
			exports: { default: new WasmModule(await Bun.file(args.path).arrayBuffer()) },
			loader: "object",
		}));
	},
});

// Workers exposes `scheduler.wait` as a global; the reference phase paces its
// api.scryfall.com requests with it. Bun does not, and without this the phase
// fails with a ReferenceError that has nothing to do with the code under test.
(globalThis as { scheduler?: { wait(ms: number): Promise<void> } }).scheduler ??= {
	wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
