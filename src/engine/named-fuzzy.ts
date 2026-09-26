// `/cards/named?fuzzy=`'s three stages — exact, then typo, then containment — asked one after
// another, and the one-store bundle that answers all three at once (backlog n7). Its own module so
// the route, the partitioned engine, the remote client and the tests share one definition of each
// without importing the wasm-backed store.

import { decodeFuzzyCandidates } from "./fuzzy-wire";
import {
	type Engine,
	type ExactNameProbe,
	FUZZY_WEAK_BELOW,
	type FuzzyCandidateWire,
	type NamedFuzzyAnswer,
	type NamedFuzzyBundle,
	type ScryfallFuzzyResult,
} from "./types";

/** How many names the containment stage asks for: two is all it takes to tell "one match" from
 * "ambiguous"; asking for more would scan the same corpus to throw the rest away. */
export const NAMED_CONTAINMENT_LIMIT = 2;

/**
 * The three stages, each asked of `engine` in turn and each read exactly as the route always has:
 * an exact hit is the answer; otherwise the typo stage's ambiguity or hit; otherwise containment,
 * where two DISTINCT names are ambiguous. What the route runs on an engine with no better way
 * (`Engine.scryfallNamedFuzzy`), and what the partitioned engine falls back to on a combination
 * of bundles it cannot read.
 *
 * A WEAK typo winner (under FUZZY_WEAK_BELOW) asks containment before it answers: the one card
 * that carries every query word outranks it, and it answers only when no single card does
 * (`weakWinnerOrContained`).
 */
export async function resolveNamedFuzzyStaged(
	engine: Engine,
	folded: string,
	words: string[],
	setCode: string,
	baseUrl: string,
): Promise<NamedFuzzyAnswer> {
	const exactHit = await engine.scryfallExactName(folded, setCode, baseUrl);
	if (exactHit) return { status: "card", card: exactHit };

	const { status, card } = await engine.scryfallFuzzyName(folded, baseUrl, setCode);
	if (status === "ambiguous") return { status: "ambiguous" };
	if (status === "hit" && card) return { status: "card", card };

	const contained = await engine.scryfallNamesContaining(words, setCode, NAMED_CONTAINMENT_LIMIT, baseUrl);
	if (status === "weak" && card) return weakWinnerOrContained(card, contained);
	if (contained.length > 1) return { status: "ambiguous" };
	const only = contained[0];
	return only ? { status: "card", card: only } : { status: "miss" };
}

/**
 * A weak typo winner against the containment stage's answer (backlog n14): the containing card
 * when there is exactly ONE, else the winner. api.scryfall.com 2026-09-25: `fuzzy=hyd disintegrat`
 * is HYDRA Disintegrator (the typo winner, Disintegrate, scores 0.703) and `fuzzy=tuk returned`
 * Tuktuk the Returned (Returned, 0.697), while `fuzzy=bolt lightning` is Blightning (0.676) though
 * two names contain both words. See FUZZY_WEAK_BELOW for the line.
 */
export function weakWinnerOrContained(
	winner: Record<string, unknown>,
	contained: Record<string, unknown>[],
): NamedFuzzyAnswer {
	const only = contained.length === 1 ? contained[0] : undefined;
	return { status: "card", card: only ?? winner };
}

/** The per-stage calls one store answers — what a bundle is made of. */
export interface NamedFuzzyStages {
	scryfallExactNameProbe(folded: string, setCode: string, baseUrl: string): Promise<ExactNameProbe>;
	fuzzyCandidates(name: string, setCode: string): Promise<FuzzyCandidateWire[]>;
	scryfallFuzzyName(name: string, baseUrl: string, setCode: string): Promise<ScryfallFuzzyResult>;
	scryfallNamesContaining(
		words: string[],
		setCode: string,
		limit: number,
		baseUrl: string,
	): Promise<Record<string, unknown>[]>;
}

/**
 * One store's bundle built from its separate stage calls, under the skip rules engine/wasm's
 * `named_fuzzy_bundle` applies (and its Rust test pins byte-for-byte against those same calls):
 * an exact rank skips everything else; a STRONG typo candidate (at or above FUZZY_WEAK_BELOW)
 * skips containment, while only weak ones keep it (backlog n14); no candidate means a local typo
 * miss without asking.
 *
 * Production never calls it: every store answers the bundle itself. It is the TypeScript
 * statement of those skip rules, which tests/engine/named-fuzzy.test.ts builds each partition's
 * bundle from. (It was RemoteEngine's fallback for objects on the build before the bundle,
 * removed once every object on both accounts had served a deploy with it.)
 */
export async function bundleFromStages(
	stages: NamedFuzzyStages,
	folded: string,
	setCode: string,
	words: string[],
	limit: number,
	baseUrl: string,
): Promise<NamedFuzzyBundle> {
	const exact = await stages.scryfallExactNameProbe(folded, setCode, baseUrl);
	if (exact.rank !== null) return { exact, fuzzy: null, candidates: [], contained: null };
	const candidates = await stages.fuzzyCandidates(folded, setCode);
	if (candidates.length > 0) {
		const fuzzy = await stages.scryfallFuzzyName(folded, baseUrl, setCode);
		// The engine compares in f32: the candidate's score is one, and so is the line it receives.
		const strong = Math.max(...candidates.map((c) => c.score)) >= Math.fround(FUZZY_WEAK_BELOW);
		const contained = strong ? null : await stages.scryfallNamesContaining(words, setCode, limit, baseUrl);
		return { exact, fuzzy, candidates, contained };
	}
	return {
		exact,
		fuzzy: { status: "miss", card: null },
		candidates,
		contained: await stages.scryfallNamesContaining(words, setCode, limit, baseUrl),
	};
}

/** `named_fuzzy_bundle`'s packet with its engine rows still rows — the store maps them to cards. */
export interface NamedFuzzyPacket<Row> {
	exact: { rank: number[] | null; present: boolean; card: Row | null };
	fuzzy: { status: ScryfallFuzzyResult["status"]; card: Row | null } | null;
	candidates: FuzzyCandidateWire[];
	contained: Row[] | null;
}

const utf8 = new TextDecoder();

/**
 * Decode `named_fuzzy_bundle`'s packet: `header_len: u32 LE`, a JSON header
 * `{"exact": …, "fuzzy": … | null, "contained": … | null}`, then `fuzzy_candidates`' packet
 * unchanged — or nothing, when the store ranked the needle exactly and skipped the typo stage.
 */
export function decodeNamedFuzzyPacket<Row>(packet: Uint8Array): NamedFuzzyPacket<Row> {
	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	const headerLen = view.getUint32(0, true);
	const header = JSON.parse(utf8.decode(packet.subarray(4, 4 + headerLen))) as Omit<
		NamedFuzzyPacket<Row>,
		"candidates"
	>;
	const tail = packet.subarray(4 + headerLen);
	return { ...header, candidates: tail.byteLength === 0 ? [] : decodeFuzzyCandidates(tail) };
}
