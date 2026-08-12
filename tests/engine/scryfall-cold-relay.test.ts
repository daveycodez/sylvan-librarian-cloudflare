// The relay condition for /cards/* queries.
//
// A colo's Durable Object can be fully warm for /search and still ~250-350ms of CPU away from
// answering a card object, because the residue archive is attached only on first /cards/* use —
// deliberately, so a search-only colo never carries its ~11.8MB. The cold relay races a local load
// against the region's DO precisely so nobody waits on a load, but it only ever asked whether the
// STORE was loaded, so that attach was paid in front of the first user to ask for a card.
//
// This pins the question the card routes actually need asked. Production cannot show it: a fresh
// deployment makes the store and the residue cold together, so a relay there proves only that the
// store was missing.

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

/** Flipped per test: the two states the relay decision reads. */
let storeLoaded = true;
let residueAttached = true;

const localEngine = {
	scryfallSearch: async () => ({ totalCards: 1, cardsBytes: new Uint8Array([91, 93]), rowCount: 0, from: "local" }),
};

mock.module("../../src/engine/store", () => ({
	getEngine: async () => localEngine,
	tryGetLoadedEngine: () => (storeLoaded ? localEngine : null),
	compatAttached: () => storeLoaded && residueAttached,
}));

const { SearchEngine } = await import("../../src/engine/search-engine-do");

/** Records whether the regional stub was asked, and answers instantly when it is. */
let regionAsked = false;
function makeDo() {
	const env = {
		SEARCH_ENGINE: {
			idFromName: (name: string) => name,
			get: () => ({
				scryfallSearch: async () => {
					regionAsked = true;
					return { totalCards: 1, cardsBytes: new Uint8Array([91, 93]), rowCount: 0, from: "region" };
				},
				size: async () => 1,
			}),
		},
	};
	return new SearchEngine({ waitUntil: () => {} } as never, env as never) as unknown as {
		scryfallSearch: (o: unknown, b: string, hint?: unknown) => Promise<{ relayed?: boolean }>;
	};
}

const OPTS = {
	filterTreeJson: "{}",
	unique: "card",
	prefer: "default",
	orderby: "name",
	direction: "asc",
	limit: 1,
	offset: 0,
	fields: [],
};

describe("/cards/* cold relay", () => {
	beforeEach(() => {
		regionAsked = false;
		storeLoaded = true;
		residueAttached = true;
	});

	test("a fully warm DO answers locally and never asks the region", async () => {
		await makeDo().scryfallSearch(OPTS, "https://api.example", "wnam");
		expect(regionAsked).toBe(false);
	});

	// The case this exists for, and the one the store-only condition missed.
	test("store warm but residue NOT attached still relays", async () => {
		residueAttached = false;
		await makeDo().scryfallSearch(OPTS, "https://api.example", "wnam");
		expect(regionAsked).toBe(true);
	});

	test("store cold relays, as it always did", async () => {
		storeLoaded = false;
		await makeDo().scryfallSearch(OPTS, "https://api.example", "wnam");
		expect(regionAsked).toBe(true);
	});

	// No hint means no region to relay TO — the regional DO itself is called without one, which is
	// what bounds the recursion at depth 1.
	test("without a fallback hint it answers locally however cold it is", async () => {
		storeLoaded = false;
		residueAttached = false;
		await makeDo().scryfallSearch(OPTS, "https://api.example", undefined);
		expect(regionAsked).toBe(false);
	});
});
