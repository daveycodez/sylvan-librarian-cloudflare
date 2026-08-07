// Container-enabled Durable Object orchestrating store imports.
//
// One named instance ("singleton") serializes all import runs. Triggers:
//   - nightly cron (src/index.ts scheduled handler)
//   - first-request bootstrap (src/engine/store.ts, when R2 has no manifest)
// Both call /start-import; a run already in flight makes that a no-op, so the
// two triggers can never race a second container into existence.
//
// The container (Dockerfile → sylvan-store-builder --serve) exposes on :8080:
//   POST /run     start an import (409 if one is running inside the container)
//   GET  /status  {"state":"idle|running|done|failed","phase":...,"detail":...}
// Success is ultimately judged by the manifest in R2 advancing — the builder
// uploads store + manifest before reporting done — so a lost container just
// means a re-run, never a wrong store.

import { Container } from "@cloudflare/containers";
import type { Env } from "./engine/types";

interface RunRecord {
	state: "idle" | "starting" | "running" | "done" | "failed";
	reason?: string;
	startedAt?: string;
	finishedAt?: string;
	exitCode?: number;
	detail?: string;
}

// A run older than this with no live container is considered lost (builder
// imports finish in minutes; 45 min covers slow Scryfall days with margin).
const STALE_RUN_MS = 45 * 60 * 1000;

export class ImportCoordinator extends Container<Env> {
	defaultPort = 8080;
	// Safety net: reap an idle container even if we lose track of it. Normal
	// shutdown is destroy() once /status reports done/failed.
	sleepAfter = "30m";
	enableInternet = true; // Scryfall bulk data + R2 S3 endpoint

	constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
		super(ctx, env);
		this.envVars = {
			R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
			R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
			CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
			R2_BUCKET: env.R2_BUCKET,
		};
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/start-import":
				return this.startImport(url.searchParams.get("reason") ?? "unspecified");
			case "/status":
				return this.status();
			default:
				return new Response("not found", { status: 404 });
		}
	}

	private async getRun(): Promise<RunRecord> {
		return (await this.ctx.storage.get<RunRecord>("run")) ?? { state: "idle" };
	}

	private async startImport(reason: string): Promise<Response> {
		const run = await this.getRun();
		if (run.state === "starting" || run.state === "running") {
			const age = run.startedAt ? Date.now() - Date.parse(run.startedAt) : 0;
			if (age < STALE_RUN_MS) {
				return Response.json({ ok: true, alreadyRunning: true, run }, { status: 202 });
			}
			console.warn(`Import run stale after ${age}ms; restarting (reason=${reason})`);
		}

		const record: RunRecord = { state: "starting", reason, startedAt: new Date().toISOString() };
		await this.ctx.storage.put("run", record);
		try {
			await this.startAndWaitForPorts();
			const res = await this.containerFetch(new Request("http://builder/run", { method: "POST" }), 8080);
			if (!res.ok && res.status !== 409) {
				throw new Error(`builder /run answered ${res.status}: ${await res.text()}`);
			}
			record.state = "running";
			await this.ctx.storage.put("run", record);
			return Response.json({ ok: true, run: record }, { status: 202 });
		} catch (err) {
			record.state = "failed";
			record.finishedAt = new Date().toISOString();
			record.detail = String(err);
			await this.ctx.storage.put("run", record);
			console.error("Failed to start import container:", err);
			return Response.json({ ok: false, run: record }, { status: 500 });
		}
	}

	private async status(): Promise<Response> {
		const run = await this.getRun();
		if (run.state === "running" || run.state === "starting") {
			try {
				const res = await this.containerFetch(new Request("http://builder/status"), 8080);
				if (res.ok) {
					const builder = (await res.json()) as { state?: string; phase?: string; detail?: string };
					if (builder.state === "done" || builder.state === "failed") {
						run.state = builder.state;
						run.finishedAt = new Date().toISOString();
						run.detail = builder.detail;
						await this.ctx.storage.put("run", run);
						// The run is over; stop paying for the container.
						this.ctx.waitUntil(this.destroy());
					}
					return Response.json({ run, builder });
				}
			} catch (err) {
				// Container unreachable while nominally running: surface, don't lie.
				return Response.json({ run, builder: { state: "unreachable", detail: String(err) } });
			}
		}
		return Response.json({ run });
	}

	override onStop(params: { exitCode: number; reason: string }): void {
		// Ground truth for success is the R2 manifest; this just records the exit.
		// Guarded: these lifecycle hooks also fire mid platform resets (code
		// updates, storage resets), where storage access itself throws — a
		// bookkeeping failure must not escalate into a crashing error handler.
		this.ctx.waitUntil(
			(async () => {
				const run = await this.getRun();
				if (run.state === "running" || run.state === "starting") {
					run.state = params.exitCode === 0 ? "done" : "failed";
					run.finishedAt = new Date().toISOString();
					run.exitCode = params.exitCode;
					run.detail = `container exited (${params.reason})`;
					await this.ctx.storage.put("run", run);
				}
			})().catch((err) => {
				console.warn(`onStop bookkeeping skipped (storage unavailable): ${err}`);
			}),
		);
	}

	override onError(error: unknown): void {
		console.error("ImportCoordinator container error:", error);
		this.ctx.waitUntil(
			(async () => {
				const run = await this.getRun();
				run.state = "failed";
				run.finishedAt = new Date().toISOString();
				run.detail = String(error);
				await this.ctx.storage.put("run", run);
			})().catch((err) => {
				console.warn(`onError bookkeeping skipped (storage unavailable): ${err}`);
			}),
		);
	}
}
