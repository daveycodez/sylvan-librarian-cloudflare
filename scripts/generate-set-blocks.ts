// Turn api.scryfall.com's `/sets` into the committed table behind `block:` / `b:`.
//
// Scryfall's syntax page: "Use b: or block: to find cards in a Magic block by providing the
// three-letter code for any set in that block." Blocks are not in the bulk card data at all — a
// card object carries its set and nothing about that set's block — but every set object carries
// `block_code` and `parent_set_code`, and the measured rule is a function of those two.
//
// ─── THE RULE ────────────────────────────────────────────────────────────────────────────────
//
// Measured on api.scryfall.com 2026-10-03/04, one request per row (unique=cards):
//
//   block:zen = block:wwk = block:roe = block:tzen = block:pzen   629
//       e:zen or e:wwk or e:roe is 607, and `block:zen -t:token -t:emblem` is that 607: the
//       block's TOKEN and PROMO sets are members (tzen, twwk, troe, pzen, pwwk, proe all carry
//       block_code `zen`), and the term opens extras so the tokens are seen.
//   block:lea = block:m10                     3,579   every core set carries block_code `lea`
//   block:mid 727, block:dbl 728              `dbl` is a block code AND a set that is not itself
//                                             in the block: asked by name it adds its own cards
//   block:htr 31, block:y22 516               a block code that is no set's code at all
//   block:khm                                   305 = e:khm   no block, no parent: the set alone
//   block:tkhm 328 = e:khm ∪ e:tkhm; block:pkhm 307; block:akhm 384 = `e:akhm or e:khm`
//       a set with no block of its own answers WITH ITS PARENT — and the parent does not answer
//       with its children (block:khm is not 328).
//   block:khc                                 7,558   khc ∪ its parent khm ∪ its block `cmd` (7,302)
//   block:tecc 166 = `e:tecc or e:ecc`; block:pbig 30 = `e:pbig or e:big`
//       the PARENT's block is not followed: ecc is in `cmd` and big in `otj`, and neither comes.
//   block:nonsense                              404, no warning
//
// So, for a value X naming set S (or no set):
//
//   members(X) = {S} ∪ {parent(S)} ∪ { T : block_code(T) ∈ {X, block_code(S)} }
//
// which needs, per set, its parent and its block code — the two columns this file writes.
//
// ─── WHAT IS NOT HERE ────────────────────────────────────────────────────────────────────────
//
// Scryfall also resolves X as a set NAME, by the resolver `e:` uses: `block:"time spiral"`,
// `block:timespiral`, `block:zendikar` and `block:"urza's saga"` answer their blocks, as do the
// nicknames `masques`, `kamigawa`, `ravnica` and `"double feature"` — while the block names
// `urza`, `alara`, `"core set"` and `commander` do not, so it is the set resolver and not the
// `block` field. This port's `e:` takes codes only, and so does its `block:`: a name answers
// nothing here, which is narrower than Scryfall and never wider. The documented spelling is the
// code.
//
//   bun run set-blocks
//
// Run by hand and the diff committed, for the reasons scripts/generate-set-dates.ts gives. A set
// released after the last refresh is absent from the table, and `block:<its code>` then answers
// that set alone — exact for a set with no block and no parent, which every new expansion is.

import { writeFileSync } from "node:fs";

const OUT = "src/routes/scryfall-compat/set-blocks.gen.ts";
const SETS_URL = "https://api.scryfall.com/sets";
const CODE_RE = /^[0-9a-z]{1,8}$/;

interface SetObject {
	code?: unknown;
	block_code?: unknown;
	parent_set_code?: unknown;
}

async function main(): Promise<void> {
	const res = await fetch(SETS_URL, {
		headers: { "User-Agent": "sylvan-librarian-cloudflare/generate-set-blocks", Accept: "application/json" },
	});
	if (!res.ok) {
		console.error(`GET ${SETS_URL} answered ${res.status}`);
		process.exit(1);
	}
	const payload = (await res.json()) as { data?: unknown };
	const sets = payload.data;
	if (!Array.isArray(sets) || sets.length === 0) throw new Error("/sets answered no data");

	const code = (value: unknown, what: string): string => {
		if (typeof value !== "string" || value === "") return "";
		const lower = value.toLowerCase();
		if (!CODE_RE.test(lower)) throw new Error(`unexpected ${what} ${JSON.stringify(value)}`);
		return lower;
	};

	// `code:parent:block`, only for the sets that have either. A set with neither is its own whole
	// answer, which is also what an unknown code gets — so leaving it out loses nothing.
	const rows: string[] = [];
	for (const entry of sets as SetObject[]) {
		const own = code(entry.code, "set code");
		if (own === "") continue;
		const parent = code(entry.parent_set_code, `parent of ${own}`);
		const block = code(entry.block_code, `block of ${own}`);
		if (parent === "" && block === "") continue;
		rows.push(`${own}:${parent}:${block}`);
	}
	if (rows.length === 0) throw new Error("/sets answered no set with a block or a parent");
	rows.sort();

	const source = `// GENERATED FILE - do not edit. Built by scripts/generate-set-blocks.ts from api.scryfall.com/sets.
//
// The two set-object fields \`block:\` / \`b:\` are a function of — \`parent_set_code\` and
// \`block_code\` — for every set that has either. See the generator for the measured rule, and for
// why a set NAME is not resolved here.
//
// Committed and refreshed by hand with \`bun run set-blocks\`, never at deploy time.

// One string literal, parsed on first use: \`code:parent:block\` rows joined by \`|\`.
const SET_BLOCKS =
	"${rows.join("|")}";

interface SetBlocks {
	/** set code -> [parent set code or "", block code or ""] */
	readonly sets: ReadonlyMap<string, readonly [string, string]>;
	/** block code -> the set codes carrying it */
	readonly members: ReadonlyMap<string, readonly string[]>;
}

let parsed: SetBlocks | null = null;

function setBlocks(): SetBlocks {
	if (parsed === null) {
		const sets = new Map<string, readonly [string, string]>();
		const members = new Map<string, string[]>();
		for (const row of SET_BLOCKS.split("|")) {
			const [code, parent, block] = row.split(":") as [string, string, string];
			sets.set(code, [parent, block]);
			if (block !== "") {
				const list = members.get(block);
				if (list) list.push(code);
				else members.set(block, [code]);
			}
		}
		parsed = { sets, members };
	}
	return parsed;
}

/**
 * The set codes \`block:<value>\` answers with, sorted — the set itself, its parent, and every set
 * of the block the value names or the set belongs to. Case-insensitive. A value this table does
 * not know answers itself alone: a set with no block and no parent, or one released since the
 * table was refreshed.
 */
export function blockSetCodes(value: string): string[] {
	const code = value.toLowerCase();
	const { sets, members } = setBlocks();
	const out = new Set<string>([code]);
	const [parent, block] = sets.get(code) ?? ["", ""];
	if (parent !== "") out.add(parent);
	for (const key of [code, block]) {
		if (key === "") continue;
		for (const member of members.get(key) ?? []) out.add(member);
	}
	return [...out].sort();
}
`;

	writeFileSync(OUT, source);
	console.log(`Wrote ${OUT} — ${rows.length} sets with a block or a parent`);
}

await main();
