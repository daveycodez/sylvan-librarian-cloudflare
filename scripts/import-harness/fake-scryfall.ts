// api.scryfall.com's `/cards/search` and `/sets`, as far as the nightly's `is:` list refresh can
// tell (src/import-is-lists.ts) — for tests/import/is-lists-refresh.test.ts and for the harness's
// dump server, which hands it the list requests.
//
// It answers exactly the queries the refresh writes: `is:V` and `-is:V` terms, `lang:any`,
// `lang:en`, `-lang:en` and `e:SET`, with `unique=prints|cards` and `page=N`, in Scryfall's
// envelope — `total_cards`, `has_more`, a 404 `not_found` for no match. With no `lang:` term a
// printing answers with its English row, or its only one, as Scryfall's default does.
//
// A term it does not know is answered with a WARNING, as Scryfall answers one, so a query this
// file was not taught fails the refresh's own check instead of matching everything.

import type { SearchAnswer } from "../../src/import-is-lists";

export interface FakeCard {
	id: string;
	oracle_id: string;
	name: string;
	set: string;
	collector_number: string;
	lang: string;
	all_parts?: unknown[];
	/** The `is:` values this row is in. */
	is: string[];
}

export interface FakeSet {
	code: string;
	released_at: string;
	/** Overrides the count of the set's printings (to say "moved" without adding a card). */
	card_count?: number;
}

/** What to answer instead of the truth: a canned answer, or `"throw"` for a transport failure. */
export type Fault = (path: string, nth: number) => SearchAnswer | "throw" | null;

export class FakeScryfall {
	/** Every path asked, in order. */
	readonly asked: string[] = [];
	pageRows = 175;
	fault: Fault | null = null;

	constructor(
		public cards: FakeCard[],
		public sets: FakeSet[],
	) {}

	/** The printings (set, number) of a set. */
	printings(code: string): number {
		return new Set(this.cards.filter((c) => c.set === code).map((c) => c.collector_number)).size;
	}

	/** The rows `q` answers, in a stable order. */
	rows(q: string, unique: string): FakeCard[] | { warning: string } {
		let rows = [...this.cards];
		let lang: string | null = null;
		for (const term of q.split(" ").filter(Boolean)) {
			const negated = term.startsWith("-");
			const [key, value] = (negated ? term.slice(1) : term).split(":") as [string, string | undefined];
			if (!value) return { warning: `Invalid expression “${term}” was ignored.` };
			if (key === "is") rows = rows.filter((c) => c.is.includes(value) !== negated);
			else if (key === "e" && !negated) rows = rows.filter((c) => c.set === value);
			else if (key === "lang" && value === "any" && !negated) lang = "any";
			else if (key === "lang" && value === "en") lang = negated ? "-en" : "en";
			else return { warning: `Invalid expression “${term}” was ignored.` };
		}
		if (lang === "en") rows = rows.filter((c) => c.lang === "en");
		else if (lang === "-en") rows = rows.filter((c) => c.lang !== "en");
		else if (lang === null) {
			// One row a printing: its English one, or the one it has. Decided over the whole
			// corpus, then filtered — a printing whose English row does not match is not answered
			// by another of its rows.
			const chosen = new Map<string, FakeCard>();
			for (const c of this.cards) {
				const key = `${c.set}\t${c.collector_number}`;
				const held = chosen.get(key);
				if (!held || (held.lang !== "en" && c.lang === "en")) chosen.set(key, c);
			}
			const defaults = new Set([...chosen.values()].map((c) => c.id));
			rows = rows.filter((c) => defaults.has(c.id));
		}
		rows.sort((a, b) =>
			a.name !== b.name
				? a.name < b.name
					? -1
					: 1
				: `${a.set}/${a.collector_number}/${a.lang}` < `${b.set}/${b.collector_number}/${b.lang}`
					? -1
					: 1,
		);
		if (unique === "cards") {
			const seen = new Set<string>();
			rows = rows.filter((c) => !seen.has(c.oracle_id) && seen.add(c.oracle_id));
		}
		return rows;
	}

	/** The truth for one path, no faults. */
	truth(path: string): SearchAnswer {
		const url = new URL(path, "https://fake.invalid");
		if (url.pathname === "/sets") {
			return {
				status: 200,
				body: {
					object: "list",
					has_more: false,
					data: this.sets.map((s, i) => ({
						object: "set",
						id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
						code: s.code,
						name: `Set ${s.code.toUpperCase()}`,
						set_type: "expansion",
						released_at: s.released_at,
						card_count: s.card_count ?? this.printings(s.code),
						digital: false,
						foil_only: false,
						icon_svg_uri: `https://example.invalid/${s.code}.svg`,
					})),
				},
			};
		}
		if (url.pathname !== "/cards/search") return { status: 404, body: { object: "error", code: "not_found" } };
		const q = url.searchParams.get("q") ?? "";
		const rows = this.rows(q, url.searchParams.get("unique") ?? "cards");
		if (!Array.isArray(rows)) {
			return {
				status: 200,
				body: { object: "list", total_cards: 0, has_more: false, data: [], warnings: [rows.warning] },
			};
		}
		if (rows.length === 0) {
			return { status: 404, body: { object: "error", code: "not_found", status: 404, details: "No cards found." } };
		}
		const page = Number(url.searchParams.get("page") ?? 1);
		const data = rows.slice((page - 1) * this.pageRows, page * this.pageRows);
		if (data.length === 0) return { status: 422, body: { object: "error", code: "validation_error", status: 422 } };
		return {
			status: 200,
			body: {
				object: "list",
				total_cards: rows.length,
				has_more: page * this.pageRows < rows.length,
				data: data.map(({ is: _is, ...card }) => ({ object: "card", ...card })),
			},
		};
	}

	/** One request: logged, then the fault's answer or the truth. Throws for a `"throw"` fault. */
	answer(path: string): SearchAnswer {
		this.asked.push(path);
		const fault = this.fault?.(path, this.asked.length) ?? null;
		if (fault === "throw") throw new Error("fake Scryfall: connection reset");
		return fault ?? this.truth(path);
	}
}
