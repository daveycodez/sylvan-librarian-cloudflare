// The STRUCTURE checks that stand where the parity harnesses' volatile reductions blind them.
//
// Both scripts/live-parity.ts and scripts/parity-sweep.ts null every member of `prices` and cut the
// `?<epoch>` cache-buster off every `image_uris` URL before comparing bodies, because those values
// genuinely move day to day and a value comparison would go red every morning. That reduction is
// right, and it is also a hole big enough to hide a field in: for the entire life of both harnesses
//
//   * `prices.usd_foil`, `prices.usd_etched` and `prices.eur_foil` were null on EVERY card the
//     mirror served, where api.scryfall.com serves values on tens of thousands, and
//   * no image URL the mirror served carried a cache-buster at all, where every Scryfall one does,
//
// because two engine readers applied a number-only parse to values Scryfall sends as STRINGS — the
// prices as decimal strings ("60.00"), `image_updated_at` as an ISO-8601 timestamp. Both harnesses
// were green the whole time, and the bugs were found by hand while writing an unrelated exporter.
// Fixed 2026-08-16 in card_engine's `jv_opt_price_cents`/`opt_price_cents` and
// `jv_opt_image_updated_at`/`opt_image_updated_at`; this file is the guard that keeps the class
// from recurring behind the same blind spot.
//
// A THIRD bug hid here for the same reason and was found the same way, by hand: Scryfall serves
// ELEVEN keys under `image_uris` and this mirror served six, missing `thumb`, `grid`, `display`,
// `art` and `crop` on every card object and every face of every card object it had ever emitted.
// This file was the guard that should have caught it and did not, because it only ever compared the
// values it found at PAIRED paths — a key Scryfall had and we did not simply had no pair, so it was
// skipped rather than reported, and the run-level counter it did keep was left reading 0.52 (168,114
// ours to 320,639 theirs, which is 6/11) with nothing configured to call that a failure.
//
// So the rule this file exists to enforce is now stated properly: IGNORE THE VALUE, ASSERT THE KEY
// SET. A reduction that erases values must not also erase which keys were there, or it stops being
// a reduction and becomes a hole. Check 1 below is the new one.
//
// Everything asserted here is SHAPE or PRESENCE, never a value, so no assertion in this file can go
// red because a price moved overnight:
//
//   1. PER OBJECT, paired by path. Where Scryfall serves a `prices` or an `image_uris`, ours must
//      carry the SAME KEYS IN THE SAME ORDER. This is the check that stands directly in the hole
//      the reduction opens: both harnesses blank these values, so the key set is the only thing
//      left to compare and something has to compare it. Fully deterministic — a key set is a
//      property of the serializer, never of today's market or today's image pipeline.
//   2. PER VALUE, our side only. A price we serve must be a decimal string; a cache-buster we serve
//      must be an epoch inside a plausible window. Fully deterministic — the mirror's own output has
//      to be well-formed no matter what either corpus says today.
//   3. PER URL, paired by path. Where Scryfall's image URL carries a cache-buster, ours must too.
//      Presence, not value: ours is present exactly when `image_updated_at` is, which is a property
//      of the row rather than of the day.
//   4. PER RUN, per volatile key. A key Scryfall served a value for on at least MIN_LIVE_CARDS cards
//      must be non-null on at least one card on our side. Deliberately a run-level existence check
//      and not a per-card one: one card's foil price appearing or vanishing between our nightly
//      import and the live API is ordinary churn, while a key that is dead across an entire run is
//      precisely the bug class — and needs no per-card agreement to detect. This covers `prices`,
//      the image cache-buster, and the two RANK keys.
//
// `edhrec_rank` and `penny_rank` are in check 4 because they are the one other thing both harnesses
// erase, and they are erased HARDER than prices are: `prices` is blanked value-by-value with its
// keys left standing, so a missing price key still fails the byte comparison, but the ranks are in
// VOLATILE_KEYS and `stripPatternKeys` deletes them key and all from BOTH sides. Nothing outside
// this file would notice either rank going permanently dark. Audited against the store at the time
// this check was added — 80 printings sampled from the 2026-08-16 all_cards bulk that carry a rank,
// compared per id against the mirror, zero mismatches — so the check is a guard on a currently
// healthy field rather than a report of a live bug.
//
// Consumed by both harnesses; it lives in its own module rather than being duplicated because the
// point of it is that the two harnesses share the blind spot.

/** Scryfall's `prices` members, in the order it serves them. */
export const PRICE_KEYS = ["usd", "usd_foil", "usd_etched", "eur", "eur_foil", "tix"] as const;

/**
 * The volatile SCALARS both harnesses delete outright — key and all, from both sides — rather than
 * blanking in place the way they do a price. Nothing else compares their presence, so check 4 does.
 */
export const RANK_KEYS = ["edhrec_rank", "penny_rank"] as const;

/** The flat scalar maps the harnesses blank the values of. Their KEY SETS are check 1's subject. */
const KEY_SET_FIELDS = new Set(["prices", "image_uris"]);

/** What a price on the wire looks like — Python's `f"{v:.2f}"`, which is what this port emits too. */
const DECIMAL_PRICE = /^\d+\.\d{2}$/;

/** The cache-buster: a bare `?<digits>` query on an image URL, no key and no other parameters. */
const CACHE_BUSTER = /\?(\d+)$/;

/** 2015-01-01. Scryfall's image pipeline postdates it, so a smaller "epoch" is not one. */
const EPOCH_FLOOR = 1_420_070_400;

/**
 * How many cards Scryfall must serve a price key on before "the mirror served none" is reported.
 * A `--only`-narrowed run can legitimately touch one card whose foil price we do not have; the
 * dead-key signal needs no more than a handful of cards to be unambiguous.
 */
const MIN_LIVE_CARDS = 3;

export interface VolatileShapeTally {
	/** price key -> how many cards each side served a non-null value for. */
	prices: Map<string, { scryfall: number; ours: number }>;
	/** rank key -> how many cards each side served the key on at all. */
	ranks: Map<string, { scryfall: number; ours: number }>;
	/** image URLs carrying a cache-buster, per side. */
	images: { scryfall: number; ours: number };
	/** `prices`/`image_uris` objects whose key set was compared, and how many agreed. */
	keySets: { compared: number; agreed: number };
	/** Card objects walked, so a caller can report the sample the verdict rests on. */
	cards: number;
}

export function newVolatileShapeTally(): VolatileShapeTally {
	return {
		prices: new Map(),
		ranks: new Map(),
		images: { scryfall: 0, ours: 0 },
		keySets: { compared: 0, agreed: 0 },
		cards: 0,
	};
}

function isObject(v: unknown): v is { [key: string]: unknown } {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Collected {
	/** dotted path (`data.0.prices.usd_foil`) -> the served value. */
	prices: Map<string, unknown>;
	/** dotted path (`data.0.image_uris.large`) -> the served URL. */
	images: Map<string, string>;
	/** dotted path of the MAP itself (`data.0.image_uris`) -> its keys, in served order. */
	keySets: Map<string, string[]>;
	/** dotted path (`data.0.penny_rank`) -> the served value, for keys deleted before comparison. */
	ranks: Map<string, unknown>;
	cards: number;
}

function emptyCollected(): Collected {
	return { prices: new Map(), images: new Map(), keySets: new Map(), ranks: new Map(), cards: 0 };
}

/** Walk a parsed body, indexing every price member, image URL, rank and blanked-map key set. */
function collect(v: unknown, path: string[], out: Collected): void {
	if (Array.isArray(v)) {
		v.forEach((item, i) => {
			collect(item, [...path, String(i)], out);
		});
		return;
	}
	if (!isObject(v)) return;
	if (v.object === "card") out.cards++;
	for (const [key, value] of Object.entries(v)) {
		const here = [...path, key];
		if ((RANK_KEYS as readonly string[]).includes(key)) out.ranks.set(here.join("."), value);
		// `prices` and `image_uris` are flat maps of scalars — index them and do not descend.
		if (KEY_SET_FIELDS.has(key) && isObject(value)) {
			// The key set of the map, before anything blanks what is inside it. Recorded for BOTH
			// sides at the map's own path, so check 1 can pair them.
			out.keySets.set(here.join("."), Object.keys(value));
			if (key === "prices") {
				for (const [k, val] of Object.entries(value)) out.prices.set([...here, k].join("."), val);
			} else {
				for (const [k, val] of Object.entries(value))
					if (typeof val === "string") out.images.set([...here, k].join("."), val);
			}
		} else {
			collect(value, here, out);
		}
	}
}

/**
 * OPT-IN, PER CASE: the two sides must agree on which rows serve NO price for the named keys.
 *
 * Check 4 above is deliberately a run-level existence check, because one card's foil price
 * appearing between our nightly import and the live API is ordinary churn. That leaves one class of
 * bug it cannot see, and it is not hypothetical — it is the exact shape the `usd`/`eur` coalesce
 * fix (local 417bed6, upstream #927 10a6fb7) was built to avoid. api.scryfall.com answers
 * `usd>=500` WITH a printing whose served `"usd"` is `null`, because the foil/etched fallback lives
 * on its SEARCH KEY and not on the column it serves. Writing that coalesce into the stored column
 * instead passes every filter test and every count, and corrupts the card object on 12,865
 * printings — and since both harnesses blank price VALUES, `null` and `"4900.00"` reduce to the
 * same byte. Nothing above would notice: the key set still matches (check 1), the value is still a
 * decimal string (check 2), and the run-level counter goes UP, not down (check 4).
 *
 * So a case that exists to pin that distinction says so, and gets a per-row NULLITY comparison —
 * presence, never value, so it still cannot go red because a price moved. Opt-in rather than global
 * because global is what check 4 already refused to be, and for the same good reason.
 *
 * Only paths BOTH sides serve are compared; a row only one side has is the byte comparison's
 * business, not this one's.
 */
export function checkPriceNullity(oursBody: unknown, scryfallBody: unknown, keys: readonly string[]): string[] {
	const ours: Collected = emptyCollected();
	const theirs: Collected = emptyCollected();
	collect(oursBody, [], ours);
	collect(scryfallBody, [], theirs);

	const problems: string[] = [];
	let compared = 0;
	for (const [path, theirValue] of theirs.prices) {
		const key = path.slice(path.lastIndexOf(".") + 1);
		if (!keys.includes(key)) continue;
		if (!ours.prices.has(path)) continue;
		compared++;
		const ourValue = ours.prices.get(path);
		const theirNull = theirValue === null || theirValue === undefined;
		const ourNull = ourValue === null || ourValue === undefined;
		if (theirNull === ourNull) continue;
		problems.push(
			`${path}: Scryfall serves ${theirNull ? "null" : "a price"} and the mirror serves ` +
				`${ourNull ? "null" : "a price"}. This case declares price_nullity because the row is here to ` +
				`prove the foil/etched coalesce lives on the SEARCH KEY and not on the served column; both ` +
				`harnesses blank the value, so this is the only assertion that can tell the two apart.`,
		);
	}
	if (compared === 0)
		problems.push(
			`price_nullity [${keys.join(", ")}]: no row carried any of these keys on both sides, so the case ` +
				`asserted nothing. Either the query stopped matching the printings it was written for or the ` +
				`declaration names keys the response does not carry.`,
		);
	return problems;
}

/**
 * Check one request's two bodies and fold them into the run tally.
 *
 * Returns the problems that are decidable from this pair alone; the run-level verdict comes from
 * `volatileShapeRunProblems` once every case has been folded in.
 */
export function checkVolatileShape(oursBody: unknown, scryfallBody: unknown, tally: VolatileShapeTally): string[] {
	const ours: Collected = emptyCollected();
	const theirs: Collected = emptyCollected();
	collect(oursBody, [], ours);
	collect(scryfallBody, [], theirs);
	tally.cards += ours.cards;

	const problems: string[] = [];
	const ceiling = Math.floor(Date.now() / 1000) + 366 * 86_400;

	// 1. The KEY SET of every map whose values the harnesses blank. The whole point of the file:
	//    the reduction erases the values, so this is the only thing left that can say the object
	//    still has Scryfall's shape.
	for (const [path, theirKeys] of theirs.keySets) {
		const ourKeys = ours.keySets.get(path);
		// No map at that path at all — a missing or extra `image_uris` is a difference the byte
		// comparison can still see, because only the map's CONTENTS are reduced, not the map.
		if (ourKeys === undefined) continue;
		tally.keySets.compared++;
		if (ourKeys.length === theirKeys.length && ourKeys.every((k, i) => k === theirKeys[i])) {
			tally.keySets.agreed++;
			continue;
		}
		const field = path.slice(path.lastIndexOf(".") + 1);
		const missing = theirKeys.filter((k) => !ourKeys.includes(k));
		const extra = ourKeys.filter((k) => !theirKeys.includes(k));
		const detail = [
			missing.length ? `missing ${missing.join(", ")}` : "",
			extra.length ? `extra ${extra.join(", ")}` : "",
			!missing.length && !extra.length ? "same keys in a different ORDER" : "",
		]
			.filter(Boolean)
			.join("; ");
		problems.push(
			`${path}: the mirror serves ${ourKeys.length} ${field} key(s) where Scryfall serves ` +
				`${theirKeys.length} — ${detail}. Both harnesses blank these VALUES before comparing, so a key ` +
				`set that drifts is invisible everywhere except here. Ours [${ourKeys.join(", ")}] vs Scryfall's ` +
				`[${theirKeys.join(", ")}].`,
		);
	}

	// 2a. Every price WE serve is a decimal string.
	for (const [path, value] of ours.prices) {
		if (value === null || value === undefined) continue;
		if (typeof value !== "string" || !DECIMAL_PRICE.test(value))
			problems.push(`${path}: the mirror serves ${JSON.stringify(value)}, which is not a "0.00"-shaped price string`);
	}

	// 2b. Every cache-buster WE serve is a plausible epoch.
	for (const [path, url] of ours.images) {
		const match = CACHE_BUSTER.exec(url);
		if (!match) continue;
		const epoch = Number(match[1]);
		if (!(epoch >= EPOCH_FLOOR && epoch <= ceiling))
			problems.push(
				`${path}: cache-buster ?${match[1]} is not a plausible epoch second (expected ${EPOCH_FLOOR}..${ceiling})`,
			);
	}

	// 3. Where Scryfall's image URL has a cache-buster, ours must have one too.
	for (const [path, url] of theirs.images) {
		if (!CACHE_BUSTER.test(url)) continue;
		tally.images.scryfall++;
		const oursUrl = ours.images.get(path);
		// No URL at that path. Check 1 owns that difference now — it used to fall through to
		// nothing at all, which is how five missing image sizes rode this counter down to 6/11
		// without failing anything.
		if (oursUrl === undefined) continue;
		if (CACHE_BUSTER.test(oursUrl)) tally.images.ours++;
		else
			problems.push(
				`${path}: Scryfall's image URL carries a ?<epoch> cache-buster and the mirror's does not — ` +
					`${oursUrl} (image_updated_at is not reaching the row)`,
			);
	}

	// 4a. Tally, per price key, how many cards each side served a value for.
	for (const [path, value] of theirs.prices) {
		const key = path.slice(path.lastIndexOf(".") + 1);
		if (!(PRICE_KEYS as readonly string[]).includes(key) || value === null || value === undefined) continue;
		const seen = tally.prices.get(key) ?? { scryfall: 0, ours: 0 };
		seen.scryfall++;
		const oursValue = ours.prices.get(path);
		if (oursValue !== null && oursValue !== undefined) seen.ours++;
		tally.prices.set(key, seen);
	}

	// 4b. The same tally for the two rank keys, which both harnesses delete outright.
	for (const [path, value] of theirs.ranks) {
		if (value === null || value === undefined) continue;
		const key = path.slice(path.lastIndexOf(".") + 1);
		const seen = tally.ranks.get(key) ?? { scryfall: 0, ours: 0 };
		seen.scryfall++;
		const oursValue = ours.ranks.get(path);
		if (oursValue !== null && oursValue !== undefined) seen.ours++;
		tally.ranks.set(key, seen);
	}

	return problems;
}

/** The run-level verdict: a volatile key Scryfall serves broadly that the mirror never serves. */
export function volatileShapeRunProblems(tally: VolatileShapeTally): string[] {
	const problems: string[] = [];
	for (const key of RANK_KEYS) {
		const seen = tally.ranks.get(key);
		if (!seen || seen.scryfall < MIN_LIVE_CARDS) continue;
		if (seen.ours === 0)
			problems.push(
				`${key}: Scryfall served a value on ${seen.scryfall} card(s) this run and the mirror served none at ` +
					`all. Both harnesses put this key in VOLATILE_KEYS and delete it from BOTH sides before comparing, ` +
					`so nothing else in either run would notice it going permanently dark — check that the column is ` +
					`still populated by the import and still in CARD_OBJECT_FIELDS.`,
			);
	}
	for (const key of PRICE_KEYS) {
		const seen = tally.prices.get(key);
		if (!seen || seen.scryfall < MIN_LIVE_CARDS) continue;
		if (seen.ours === 0)
			problems.push(
				`prices.${key}: Scryfall served a value on ${seen.scryfall} card(s) this run and the mirror served ` +
					`none at all. A whole price key going dark is a reader problem, not a market one — check that ` +
					`card_engine's jv_opt_price_cents / opt_price_cents still have their STRING arm.`,
			);
	}
	if (tally.images.scryfall >= MIN_LIVE_CARDS && tally.images.ours === 0)
		problems.push(
			`image_uris: Scryfall served ${tally.images.scryfall} image URL(s) with a ?<epoch> cache-buster this run ` +
				`and the mirror served none. Check that image_updated_at (an ISO-8601 STRING from Scryfall) is still ` +
				`being parsed to epoch seconds by jv_opt_image_updated_at / opt_image_updated_at.`,
		);
	return problems;
}

/** One line for a run summary, whether or not anything failed. */
export function volatileShapeSummary(tally: VolatileShapeTally): string {
	const perKey = (map: VolatileShapeTally["prices"], keys: readonly string[]) =>
		keys
			.map((key) => {
				const seen = map.get(key);
				return `${key} ${seen?.ours ?? 0}/${seen?.scryfall ?? 0}`;
			})
			.join(", ");
	return (
		`volatile shape: ${tally.cards} card object(s); ` +
		`key sets ${tally.keySets.agreed}/${tally.keySets.compared}; ` +
		`prices ours/scryfall ${perKey(tally.prices, PRICE_KEYS)}; ` +
		`ranks ${perKey(tally.ranks, RANK_KEYS)}; ` +
		`image cache-busters ${tally.images.ours}/${tally.images.scryfall}`
	);
}
