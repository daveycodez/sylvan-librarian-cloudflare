// RemoteEngine's retry of the platform's reset failures, on both transports. A deploy resets every
// Durable Object; measured at the 2026-09-23 06:45 deploy, ~35 user requests failed with "storage is
// no longer accessible", "instance is no longer active" and "caused object to be reset" — the
// streaming /cards/search transport had no retry, and the RPC one retried only on the runtime flag.

import { describe, expect, test } from "bun:test";
import { isTransientEngineFailure, RemoteEngine } from "../../src/engine/remote-engine";
import { EngineQueryError, EngineUnavailableError, StaleModulusError } from "../../src/engine/types";

type Stub = ConstructorParameters<typeof RemoteEngine>[0];
const envelope = { pretty: false, pageOffset: 0, noMatchDetails: "" };
const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
const failed503 = (message: string, kind = "Error") =>
	new Response(message, { status: 503, headers: { "x-engine-error": kind } });

function pageStub(answers: (() => Response)[]) {
	let calls = 0;
	const stub = {
		fetch: async () => {
			const next = answers[Math.min(calls, answers.length - 1)] as () => Response;
			calls++;
			return next();
		},
	} as unknown as Stub;
	return { stub, calls: () => calls };
}

describe("which failures are repeated", () => {
	test("the runtime's flag, and the platform's reset messages even without it", () => {
		expect(isTransientEngineFailure(Object.assign(new Error("x"), { retryable: true }))).toBe(true);
		expect(isTransientEngineFailure(new Error("Durable Object storage is no longer accessible."))).toBe(true);
		expect(
			isTransientEngineFailure(
				new Error(
					"Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
				),
			),
		).toBe(true);
		expect(
			isTransientEngineFailure(
				new Error("Internal error while starting up Durable Object storage caused object to be reset; reference = x"),
			),
		).toBe(true);
		expect(isTransientEngineFailure(new Error("Network connection lost."))).toBe(true);
	});

	test("never an answer about the query or the store, and never an overload", () => {
		expect(isTransientEngineFailure(new EngineQueryError("build_filter: bad regex"))).toBe(false);
		expect(isTransientEngineFailure(new EngineUnavailableError("no store"))).toBe(false);
		expect(isTransientEngineFailure(new StaleModulusError("other count"))).toBe(false);
		expect(isTransientEngineFailure(Object.assign(new Error("busy"), { retryable: true, overloaded: true }))).toBe(
			false,
		);
		expect(isTransientEngineFailure(new Error("TypeError: something broke"))).toBe(false);
	});
});

describe("the streaming /cards/search transport", () => {
	test("a reset 503 is repeated and the page is answered", async () => {
		const { stub, calls } = pageStub([() => failed503("Durable Object storage is no longer accessible."), ok]);
		const res = await new RemoteEngine(stub, "wnam").scryfallSearchPage(
			{ limit: 10 } as never,
			"https://x",
			envelope,
			{},
		);
		expect(res.status).toBe(200);
		expect(calls()).toBe(2);
	});

	test("a thrown reset is repeated too", async () => {
		let calls = 0;
		const stub = {
			fetch: async () => {
				calls++;
				if (calls === 1) throw new Error("Connection closed: this Durable Object instance is no longer active.");
				return ok();
			},
		} as unknown as Stub;
		const res = await new RemoteEngine(stub, "wnam").scryfallSearchPage(
			{ limit: 10 } as never,
			"https://x",
			envelope,
			{},
		);
		expect(res.status).toBe(200);
		expect(calls).toBe(2);
	});

	test("a bad query is answered once, as the query error it is", async () => {
		const { stub, calls } = pageStub([() => failed503("build_filter: unclosed regex")]);
		await expect(
			new RemoteEngine(stub, "wnam").scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {}),
		).rejects.toBeInstanceOf(EngineQueryError);
		expect(calls()).toBe(1);
	});

	test("a reset that persists gives up after three attempts", async () => {
		const { stub, calls } = pageStub([() => failed503("Durable Object storage is no longer accessible.")]);
		await expect(
			new RemoteEngine(stub, "wnam").scryfallSearchPage({ limit: 10 } as never, "https://x", envelope, {}),
		).rejects.toThrow(/no longer accessible/);
		expect(calls()).toBe(3);
	});
});

describe("the RPC transport", () => {
	test("a reset without the runtime flag is repeated", async () => {
		let calls = 0;
		const stub = {
			cardCount: async () => {
				calls++;
				if (calls === 1) throw new Error("Durable Object storage is no longer accessible.");
				return 7;
			},
		} as unknown as Stub;
		expect(await new RemoteEngine(stub, "wnam").cardCount()).toBe(7);
		expect(calls).toBe(2);
	});
});
