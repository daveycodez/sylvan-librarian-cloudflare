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
// Everything asserted here is SHAPE or PRESENCE, never a value, so no assertion in this file can go
// red because a price moved overnight:
//
//   1. PER VALUE, our side only. A price we serve must be a decimal string; a cache-buster we serve
//      must be an epoch inside a plausible window. Fully deterministic — the mirror's own output has
//      to be well-formed no matter what either corpus says today.
//   2. PER URL, paired by path. Where Scryfall's image URL carries a cache-buster, ours must too.
//      Presence, not value: ours is present exactly when `image_updated_at` is, which is a property
//      of the row rather than of the day.
//   3. PER RUN, per price key. A key Scryfall served a non-null value for on at least MIN_LIVE_CARDS
//      cards must be non-null on at least one card on our side. Deliberately a run-level existence
//      check and not a per-card one: one card's foil price appearing or vanishing between our
//      nightly import and the live API is ordinary churn, while a key that is dead across an entire
//      run is precisely the bug class — and needs no per-card agreement to detect.
//
// Consumed by both harnesses; it lives in its own module rather than being duplicated because the
// point of it is that the two harnesses share the blind spot.

/** Scryfall's `prices` members, in the order it serves them. */
export const PRICE_KEYS = ["usd", "usd_foil", "usd_etched", "eur", "eur_foil", "tix"] as const;

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
	/** image URLs carrying a cache-buster, per side. */
	images: { scryfall: number; ours: number };
	/** Card objects walked, so a caller can report the sample the verdict rests on. */
	cards: number;
}

export function newVolatileShapeTally(): VolatileShapeTally {
	return { prices: new Map(), images: { scryfall: 0, ours: 0 }, cards: 0 };
}

function isObject(v: unknown): v is { [key: string]: unknown } {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Collected {
	/** dotted path (`data.0.prices.usd_foil`) -> the served value. */
	prices: Map<string, unknown>;
	/** dotted path (`data.0.image_uris.large`) -> the served URL. */
	images: Map<string, string>;
	cards: number;
}

/** Walk a parsed body, indexing every price member and image URL by its path. */
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
		// `prices` and `image_uris` are flat maps of scalars — index them and do not descend.
		if (key === "prices" && isObject(value)) {
			for (const [k, val] of Object.entries(value)) out.prices.set([...here, k].join("."), val);
		} else if (key === "image_uris" && isObject(value)) {
			for (const [k, val] of Object.entries(value))
				if (typeof val === "string") out.images.set([...here, k].join("."), val);
		} else {
			collect(value, here, out);
		}
	}
}

/**
 * Check one request's two bodies and fold them into the run tally.
 *
 * Returns the problems that are decidable from this pair alone; the run-level verdict comes from
 * `volatileShapeRunProblems` once every case has been folded in.
 */
export function checkVolatileShape(oursBody: unknown, scryfallBody: unknown, tally: VolatileShapeTally): string[] {
	const ours: Collected = { prices: new Map(), images: new Map(), cards: 0 };
	const theirs: Collected = { prices: new Map(), images: new Map(), cards: 0 };
	collect(oursBody, [], ours);
	collect(scryfallBody, [], theirs);
	tally.cards += ours.cards;

	const problems: string[] = [];
	const ceiling = Math.floor(Date.now() / 1000) + 366 * 86_400;

	// 1a. Every price WE serve is a decimal string.
	for (const [path, value] of ours.prices) {
		if (value === null || value === undefined) continue;
		if (typeof value !== "string" || !DECIMAL_PRICE.test(value))
			problems.push(`${path}: the mirror serves ${JSON.stringify(value)}, which is not a "0.00"-shaped price string`);
	}

	// 1b. Every cache-buster WE serve is a plausible epoch.
	for (const [path, url] of ours.images) {
		const match = CACHE_BUSTER.exec(url);
		if (!match) continue;
		const epoch = Number(match[1]);
		if (!(epoch >= EPOCH_FLOOR && epoch <= ceiling))
			problems.push(
				`${path}: cache-buster ?${match[1]} is not a plausible epoch second (expected ${EPOCH_FLOOR}..${ceiling})`,
			);
	}

	// 2. Where Scryfall's image URL has a cache-buster, ours must have one too.
	for (const [path, url] of theirs.images) {
		if (!CACHE_BUSTER.test(url)) continue;
		tally.images.scryfall++;
		const oursUrl = ours.images.get(path);
		// No URL at that path: the byte comparison owns that difference, not this check.
		if (oursUrl === undefined) continue;
		if (CACHE_BUSTER.test(oursUrl)) tally.images.ours++;
		else
			problems.push(
				`${path}: Scryfall's image URL carries a ?<epoch> cache-buster and the mirror's does not — ` +
					`${oursUrl} (image_updated_at is not reaching the row)`,
			);
	}

	// 3. Tally, per price key, how many cards each side served a value for.
	for (const [path, value] of theirs.prices) {
		const key = path.slice(path.lastIndexOf(".") + 1);
		if (!(PRICE_KEYS as readonly string[]).includes(key) || value === null || value === undefined) continue;
		const seen = tally.prices.get(key) ?? { scryfall: 0, ours: 0 };
		seen.scryfall++;
		const oursValue = ours.prices.get(path);
		if (oursValue !== null && oursValue !== undefined) seen.ours++;
		tally.prices.set(key, seen);
	}

	return problems;
}

/** The run-level verdict: a price key Scryfall serves broadly that the mirror never serves at all. */
export function volatileShapeRunProblems(tally: VolatileShapeTally): string[] {
	const problems: string[] = [];
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
	const priced = PRICE_KEYS.map((key) => {
		const seen = tally.prices.get(key);
		return `${key} ${seen?.ours ?? 0}/${seen?.scryfall ?? 0}`;
	}).join(", ");
	return `volatile shape: ${tally.cards} card object(s); prices ours/scryfall ${priced}; image cache-busters ${tally.images.ours}/${tally.images.scryfall}`;
}
