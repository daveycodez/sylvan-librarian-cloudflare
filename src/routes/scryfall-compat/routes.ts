// The Scryfall-compatible `/cards/*` routes. Port of api/scryfall_compat/routes.py (upstream #912).
//
// The point of this surface is that mtg-seeker can change one base URL and stop talking to
// api.scryfall.com. `/search` is untouched and keeps this project's own response shape; everything
// here answers with Scryfall's objects, Scryfall's 175-per-page pagination and Scryfall's error
// bodies.
//
// Two deliberate deviations from upstream run through the whole file:
//
//   - **No SQL fallback.** Upstream tries the engine and falls back to Postgres, distinguishing
//     "the engine could not serve" from "no such card" via an `_EngineMiss` sentinel. This
//     deployment has no Postgres, so there is no second branch to select: a miss IS the 404, an
//     engine failure IS a 500, and the sentinel has no counterpart. Recorded in the README.
//   - **Rulings come out of KV, not out of the engine.** Upstream loads them into `magic.rulings`
//     (`api/rulings_import.py`) and selects by `oracle_id`. Here the nightly import publishes them
//     as 256 KV buckets of pre-rendered Ruling objects (src/engine/rulings-kv.ts) and THIS ISOLATE
//     reads one bucket and slices one card's rulings out of it as bytes. It is the only `/cards/*`
//     answer the Durable Object has no part in, because it is the only one that needs no card
//     object assembled — just the right bytes.
//
// Every card object is built inside the Durable Object (see the Engine interface): `toScryfallCard`
// assembles ~70 keys per card, up to 175 of them for a page, and the DO meters against 30s where
// this isolate meters against 10ms.

import { encodeUtf8 } from "../../engine/bytes";
import { RulingsFormatError, rulingsBucketKey, rulingsBucketOf, rulingsSlice } from "../../engine/rulings-kv";
import type { Engine } from "../../engine/types";
import { EngineQueryError, EngineUnavailableError } from "../../engine/types";
import type { DirectiveFound, ExpandedDerivedTerm, FilterValue, LoweredRegexTerm } from "../../parser";
import { canonicalStringify } from "../../parser";
import { EXTRA_IS_TAG } from "../../parser/db-info";
import { foldAccents } from "../../parser/pystr";
import type { CardOrdering, SortDirection, UniqueOn } from "../enums";
import { CARD_ORDERING, resolveDirection } from "../enums";
import { NO_STORE_HEADER } from "../http";
import { loadParser } from "../parser-bridge";
import { arithmeticNotComparedMessage, usesValueAsPredicate } from "../query-validation";
import type { RouteContext } from "../registry";
import { applyDirectives } from "../search";
import {
	badRequestError,
	buildPageUrl,
	cardToText,
	catalogObject,
	collectionList,
	DEFAULT_IMAGE_VERSION,
	errorObject,
	imageUri,
	MAX_AUTOCOMPLETE_VALUES,
	MAX_COLLECTION_IDENTIFIERS,
	notFoundError,
	PAGE_SIZE,
	type ScryfallError,
} from "./objects";
import { scryfallTermPolicy } from "./query-terms";
import { asBool, scryfallJson, scryfallListJson } from "./respond";
import { cardName, setAndCollectorNumber, TRUE_TREE } from "./trees";

/** Path segments that name an external id namespace rather than a set code. */
const EXTERNAL_ID_NAMESPACES = ["multiverse", "mtgo", "arena", "tcgplayer", "cardmarket"] as const;

/**
 * Scryfall's `unique` vocabulary. This port's own spellings differ (`card`/`printing`/`artwork`
 * against Scryfall's `cards`/`prints`/`art`), so the mapping is explicit rather than derived.
 */
const UNIQUE_MAP: Record<string, UniqueOn> = { cards: "card", art: "artwork", prints: "printing" };

/**
 * The same mapping backwards, for the `next_page` echo.
 *
 * Scryfall echoes the RESOLVED unique mode, not the raw parameter: `q=… unique:prints` with no
 * `unique=` at all still echoes `unique=prints` (measured 2026-08-16), because an in-query
 * directive has already decided the mode by the time the link is built. Echoing the raw parameter
 * there would hand a client a link that pages a DIFFERENT result set than the page it came from.
 */
const UNIQUE_ECHO: Record<UniqueOn, string> = { card: "cards", artwork: "art", printing: "prints" };

/**
 * Scryfall's `order` vocabulary, derived from CARD_ORDERING rather than listed — an ordering added
 * to the enum is accepted here without a second edit.
 */
const ORDER_MAP: Map<string, CardOrdering> = new Map(CARD_ORDERING.values.map((m) => [m, m]));

/**
 * The two Scryfall orders with no counterpart. `penny` needs penny_rank as a sort column — it IS
 * stored (in the printing's packed `compat` residue, which the card object emits), but no sort
 * permutation is built over it, and only permuted columns can order a page; `review` is
 * Scryfall-internal with no public input and is not reproducible at all. Both fall back to `name`,
 * which is what Scryfall does with an order it does not recognize, and add a warning saying so.
 */
const SCRYFALL_ONLY_ORDERS = ["penny", "review"];

const DIRECTION_MAP: Record<string, SortDirection> = { asc: "asc", desc: "desc", auto: "auto" };

/** Scryfall's own wording, down to the typographic apostrophe, so a client that string-matches on
 * `details` behaves the same.
 *
 * The URL is `/docs/reference`, not `/docs/syntax`. Scryfall moved it and this port kept citing the
 * old page in 25 separate bodies — a client following the link landed somewhere else than the one
 * Scryfall sends it to. Re-measured 2026-08-16 on the no-match, the beyond-the-end and the
 * random-miss bodies; all three cite `reference`. */
const DOCS_REFERENCE = "https://scryfall.com/docs/reference";
const NO_MATCH_DETAILS = `Your query didn’t match any cards. Adjust your search terms or refer to the syntax guide at ${DOCS_REFERENCE}`;
/**
 * Scryfall paginates past the end with a 422, not a 404 — the query DID match, the page did not.
 *
 * Measured 2026-08-16: `e:khm` is two pages, and `page=3`, `page=007`, `page=9999` and a
 * twenty-digit page all answer `422 validation_error` with this sentence, while a query that
 * matched nothing answers the 404 above at every page. Backtick around `page` is Scryfall's.
 */
const BEYOND_END_DETAILS = `You have paginated beyond the end of these results, reduce your \`page\` parameter or refer to the syntax guide at ${DOCS_REFERENCE}`;
/** U+2018 in `didn‘t` is Scryfall's, verified byte by byte — it is not the apostrophe it looks like. */
const EMPTY_QUERY_DETAILS = "You didn‘t enter anything to search for.";
/** Scryfall's wording for `/cards/named` with neither parameter — backticks and no full stop. */
const NAMED_MISSING_PARAM_DETAILS = "You must provide a `fuzzy` or `exact` parameter";
/** Every term in the query was one Scryfall (and now this port) cannot honor. See query-terms.ts. */
const ALL_IGNORED_DETAILS = "All of your terms were ignored.";
/** Scryfall's sentence for a query whose parentheses do not balance, in either direction. */
const UNCLOSED_PARENS_DETAILS = "Your search contains unclosed parentheses.";
/** `/cards/random`'s own miss sentence, which names what it could not do rather than the query. */
const RANDOM_NO_MATCH_DETAILS = "0 cards matched this search, a random card could not be returned.";

// Scryfall's three not-found bodies, measured against api.scryfall.com on 2026-08-12. Upstream
// answers all of them with one generic string, and that string is not one of these — it carries a
// "Please double-check your URI and try again." tail Scryfall does not send. Reported against #912.
//
//   /cards/<not-an-id>, /cards/<namespace>       the generic one: the path addresses nothing
//   /cards/<id>, /cards/<ns>/<id>, /cards/<code>/<number>(/<lang>)
//                                                a card miss: the address is well-formed
//   the rulings variants                         a card miss, worded for the routes that accept
//                                                a multiverse id as well
//
// `&` rather than `and` in the rulings one, and `multiverse ID` only there, are both Scryfall's.
// Exported: dispatch answers an unknown PATH with this same sentence, which is the one Scryfall
// uses for "this address is nothing" wherever it occurs.
export const NOT_FOUND_DETAILS = "The requested object or REST method was not found.";
const CARD_NOT_FOUND_DETAILS = "No card found with the given ID or set code and collector number.";
const RULINGS_NOT_FOUND_DETAILS = "No card found with the given ID, multiverse ID, or set code & collector number.";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The STRICTER shape a `/cards/collection` identifier's UUID must have: RFC 4122 VERSION 4.
 *
 * Not the same rule as `UUID_RE` above, and the difference is measured rather than assumed
 * (api.scryfall.com, 2026-08-16, one identifier per request):
 *
 *   00000000-0000-4000-8000-000000000000   200, in `not_found`   version 4, variant 8
 *   3f2c8e5d-91b7-4a6e-9d12-4f5a9c7e8b01   200, in `not_found`   variant 9
 *   00000000-0000-0000-0000-000000000000   400 bad_request       version 0
 *   00000000-0000-0000-0000-000000000001   400 bad_request       version 0
 *   00000000-0000-4000-0000-000000000000   400 bad_request       variant 0
 *   3f2c8e5d-91b7-{0,1,5,6,7,8}a6e-bd12-…  400 bad_request       every other version nibble
 *   3f2c8e5d-91b7-4a6e-cd12-4f5a9c7e8b01   400 bad_request       variant c
 *
 * So it is the SHAPE and not the all-zero value: a nil UUID wearing v4's version and variant
 * nibbles is accepted and answered in `not_found`, and a v1 UUID is rejected. A syntactically
 * valid, unknown v4 belongs in `not_found` and must NOT 400 — that is what makes this a validation
 * rule rather than a lookup one, and `collection_uuid_rule_is_v4_shape_not_the_zero_value` pins
 * both sides of the boundary.
 *
 * `UUID_RE` stays as it is: it decides which 404 SENTENCE a `/cards/:id` miss gets, and Scryfall
 * reads that path segment with the looser rule (`/cards/00000000-0000-0000-0000-000000000000` is a
 * card miss, not a bad request). Two rules because Scryfall has two.
 */
const COLLECTION_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

/**
 * The three collection identifier keys Scryfall validates as UUIDs, in the order it checks them —
 * the same order `resolveIdentifiers` dispatches on, so the key that gets REPORTED is the key that
 * would have been used.
 */
const COLLECTION_UUID_KEYS = ["id", "oracle_id", "illustration_id"] as const;

/** The two identifier keys Scryfall validates as integers, in the order it checks them. */
const COLLECTION_INTEGER_KEYS = ["mtgo_id", "multiverse_id"] as const;

/** Identifier keys that identify a card ON THEIR OWN — one of these makes an identifier valid. */
const COLLECTION_SOLE_KEYS = ["id", "mtgo_id", "multiverse_id", "oracle_id", "illustration_id", "name"] as const;

/**
 * Every key that is part of SOME schema, in the order Scryfall lists them back in its complaint.
 *
 * `set` and `collector_number` are here and not in `COLLECTION_SOLE_KEYS` because neither
 * identifies a card alone: together they are a printing, and `set` beside `name` scopes a name.
 */
const COLLECTION_SCHEMA_KEYS = [...COLLECTION_SOLE_KEYS, "set", "collector_number"] as const;

/**
 * How much of a rejected value Scryfall echoes back: 30 characters, then U+2026.
 *
 * Measured with the same requests above — `not-a-uuid` comes back whole and every 36-character
 * UUID comes back cut at exactly 30 with an ellipsis. Spelled out because the `details` string is
 * compared byte for byte by the live-parity harness.
 */
const COLLECTION_ECHO_LIMIT = 30;

/**
 * The two batch-level `bad_request` sentences, verbatim from api.scryfall.com (2026-08-16).
 *
 * The count one names the bound rather than restating it, and it is the answer to FOUR different
 * mistakes (see the checks in `cardsCollectionHandler`), so it is written out once here rather than
 * interpolated per call site — the `75` in the text is Scryfall's sentence, not this port's
 * constant, and the two are allowed to be spelled separately.
 */
const COLLECTION_COUNT_DETAILS = "The `identifiers` list must have at least 1 and no more than 75 references.";
const COLLECTION_NOT_AN_ARRAY_DETAILS = "The `identifiers` list must be a JSON array.";

/**
 * The `bad_request` a malformed collection identifier earns, or null when the batch is well formed.
 *
 * ONE error for the whole request, from the FIRST malformed identifier — measured: a batch of a
 * real id followed by the nil UUID 400s and reports the nil one, and the same batch reversed 400s
 * and reports it too, so nothing is resolved and no partial List comes back.
 *
 * The article is always "An" because all three keys start with a vowel. (Scryfall picks it per
 * field: `multiverse_id`'s own non-integer error reads "A `multiverse_id` identifier must be an
 * integer: abc" — a separate rule this port does not yet implement.)
 */
function collectionIdentifierError(identifiers: unknown[]): ScryfallError | null {
	for (const ident of identifiers) {
		// A non-object entry does not get an identifier-shaped complaint: Scryfall answers `null` or
		// a bare string in the list with the COUNT message, as if the list were empty (measured
		// 2026-08-16). That check runs before this function, so reaching here with one is not
		// possible — the `continue` is gone rather than left as a silent accept.
		const entry = ident as Record<string, unknown>;
		const schema = collectionSchemaError(entry);
		if (schema) return schema;
		for (const key of COLLECTION_UUID_KEYS) {
			if (!(key in entry)) continue;
			const value = String(entry[key]);
			if (COLLECTION_UUID_RE.test(value)) break;
			return badRequestError(`An \`${key}\` identifier must be a valid UUID: ${echoIdentifierValue(value)}`);
		}
		for (const key of COLLECTION_INTEGER_KEYS) {
			if (!(key in entry)) continue;
			const value = entry[key];
			// Scryfall accepts the integer and the string that spells one; anything else is the
			// integer complaint. `A` rather than `An` here — both keys start with a consonant, and
			// Scryfall picks the article per field (see the UUID message, which is always `An`).
			if (typeof value === "number" ? Number.isInteger(value) : /^\s*[-+]?\d+\s*$/.test(String(value))) break;
			return badRequestError(`A \`${key}\` identifier must be an integer: ${echoIdentifierValue(String(value))}`);
		}
	}
	return null;
}

/** Truncate a rejected value the way Scryfall echoes it back. */
function echoIdentifierValue(value: string): string {
	return value.length > COLLECTION_ECHO_LIMIT ? `${value.slice(0, COLLECTION_ECHO_LIMIT)}…` : value;
}

/**
 * `Invalid identifier schema: …` — the 400 an identifier earns when its keys name no lookup.
 *
 * This port used to accept ANY object and report it in `not_found`, which reads as harmless and is
 * not: a client that sent `{"arena_id": 67330}` — a plausible mistake, since `arena_id` is a real
 * key on a card object and simply not a collection identifier — was told the card does not exist
 * rather than that the request was wrong, and would have gone looking in the wrong place.
 *
 * The valid schemas, measured one identifier per request on 2026-08-16: `id`, `mtgo_id`,
 * `multiverse_id`, `oracle_id`, `illustration_id`, `name`, and the PAIR `set` + `collector_number`.
 * `set` may also ride along with `name` (that is the name-scoped-to-a-set lookup), which is why
 * `name` alone is sufficient and `set` alone is not. Key ORDER does not matter
 * (`{collector_number, set}` resolves), and unrecognized keys are IGNORED beside a valid schema
 * (`{name, zzz}` resolves) — `lang` among them, which is worth stating outright because it looks
 * like it should work: `{set: "khm", collector_number: "40", lang: "ja"}` returns the ENGLISH card.
 *
 * The sentence's tail is the RECOGNIZED keys the identifier does carry, which is what makes the
 * message useful: `{set}` and `{set, lang}` both say "set" — you are halfway to a schema — while
 * `{}`, `{arena_id}` and `{nonsense}` all say nothing at all, because none of their keys is part of
 * any schema. Every one of those five is a measured string, not an inferred one.
 */
function collectionSchemaError(entry: Record<string, unknown>): ScryfallError | null {
	const has = (key: string): boolean => entry[key] !== undefined;
	if (COLLECTION_SOLE_KEYS.some(has)) return null;
	if (has("set") && has("collector_number")) return null;
	const present = COLLECTION_SCHEMA_KEYS.filter(has);
	return badRequestError(`Invalid identifier schema: ${present.join(", ")}`);
}

// ─── cache tiers ─────────────────────────────────────────────────────────────
//
// api.scryfall.com's own, measured against it rather than guessed:
//
//   /cards/search, /cards/:id, /cards/:set/:number, /cards/:ns/:id, /cards/autocomplete
//                                     public, max-age=57600      (16 hours)
//   /cards/named, INCLUDING its 404   public, max-age=172800     (48 hours)
//   /cards/random                     no-cache
//   POST /cards/collection            max-age=0, private, must-revalidate
//
// Matched, because cache behaviour is part of what a client observes and this surface exists so
// mtg-seeker can change one base URL and nothing else. Note these are Scryfall's, NOT /search's
// `max-age=90, stale-while-revalidate=86400`: /search answers this project's own shape to its own
// frontend, and the two surfaces have no reason to agree.
//
// ONE DEVIATION: `named` gets the SAME 16 hours as everything else, not Scryfall's 48. A card
// object embeds `prices` and this deployment rebuilds its store once a night, so no cached
// response should outlive the data it was built from by more than one import cycle — 48 hours
// lets a client hold prices from two imports ago with nothing in the response to say so. And
// `named` returns the same card object every other route here does, so there was never a reason
// for it to be the one route with a different lifetime.
//
// The tier rides on ERROR responses too, which is Scryfall's behaviour as well — an empty-query
// 400 comes back with the route's own max-age, and a `named` miss with the route's own tier.
//
// NOT matched: Scryfall's `Vary: Accept`. Its responses negotiate on the header; ours select their
// format from the `format=` query parameter, which is already part of the cache key. Sending it
// would split the edge cache per Accept value and buy nothing.
const CARDS_CACHE: Record<string, string> = { "Cache-Control": "public, max-age=57600" };
/** Not `no-store`: Scryfall sends `no-cache`, which permits storing and requires revalidation. */
const RANDOM_CACHE: Record<string, string> = { "Cache-Control": "no-cache" };
/**
 * `format=image` gets 48 hours, on EVERY route that serves one — measured 2026-08-16 on
 * `/cards/:id`, `/cards/:set/:number[/:lang]`, `/cards/named` and `/cards/random` alike, including
 * the "no image in that version" 404.
 *
 * It is the one tier this port takes from Scryfall unchanged while declining the identical number
 * on `/cards/named`'s JSON (see the block above), and the reason the two differ is the payload. A
 * card object embeds `prices`, which this deployment rebuilds nightly, so 48 hours would let a
 * client hold prices from two imports ago. An image redirect embeds nothing: the `Location` is a
 * pure function of the card's id and its `image_updated_at`, so a 48-hour-old redirect is the same
 * redirect. `/cards/random?format=image` keeps `no-cache` — there the VARIABLE is which card, and
 * caching that would stop it being random.
 */
const IMAGE_CACHE: Record<string, string> = { "Cache-Control": "public, max-age=172800" };
/**
 * A 404 about the PATH rather than about a card: the same lifetime, without `public`.
 *
 * Measured beside its twin — `/cards/<v4-uuid>` that resolves nothing is `public, max-age=57600`
 * and `/cards/not-a-uuid` is bare `max-age=57600`. The two are nearly the same instruction (a
 * `max-age` on a response with no `Authorization` is already shared-cacheable), which is why it is
 * worth saying that this is copied rather than reasoned: the pair is a real, repeatable split in
 * Scryfall's answers, and the point of this surface is that its answers are the same answers.
 */
const PATH_MISS_CACHE: Record<string, string> = { "Cache-Control": "max-age=57600" };
/** Scryfall's wording and tier for `face=back` on a one-faced card: a bare `public`, no max-age. */
const NO_SECOND_FACE_DETAILS = "This card does not have a second face";
const SECOND_FACE_CACHE: Record<string, string> = { "Cache-Control": "public" };
const COLLECTION_CACHE: Record<string, string> = { "Cache-Control": "max-age=0, private, must-revalidate" };
/**
 * A collection request Scryfall REFUSED: `no-cache`, not the route's own tier.
 *
 * Measured 2026-08-16 across every 400 this route can produce — the count sentence, the array
 * sentence, `Invalid identifier schema`, the UUID and integer complaints. The successful answer
 * keeps `max-age=0, private, must-revalidate`. Nearly the same instruction, genuinely two different
 * strings, and this surface exists so the strings are the same.
 */
const COLLECTION_REFUSED_CACHE: Record<string, string> = { "Cache-Control": "no-cache" };

function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}

/** Parse an integer parameter or path segment; undefined when absent or unparseable. */
function asInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number.parseInt(value.trim(), 10);
	return Number.isNaN(n) ? undefined : n;
}

/**
 * Scryfall's `page`, which never rejects anything.
 *
 * Measured one request per row (2026-08-16, `q=e:khm`, a two-page result):
 *
 *   page=0  page=-3  page=-0  page=abc  page=  page=0x2  page=1e2   all serve PAGE 1
 *   page=2.5  page=1.9  page=+2  page=" 2"  page=2abc                truncate at the first
 *                                                                    non-digit
 *   page=007                                                         is 7, not octal — a THIRD
 *                                                                    page here, so 422
 *
 * That is Ruby's `String#to_i` (leading space, optional sign, digits, stop) followed by a clamp to
 * 1 — not integer validation. This port answered `400 "The page parameter must be a positive
 * integer."` to the first row above, which is a sentence Scryfall does not own and a rejection it
 * does not make. The only 4xx `page` earns is the 422 for a page past the end, and that one needs
 * the result count, so it is decided where the count is (search-engine-do.ts).
 */
function scryfallPage(value: string | undefined): number {
	const digits = /^\s*[-+]?\d*/.exec(value ?? "")?.[0] ?? "";
	const n = Number.parseInt(digits, 10);
	return Number.isNaN(n) || n < 1 ? 1 : n;
}

function textResponse(body: string, contentType: string, cache: Record<string, string>): Response {
	return new Response(body, { status: 200, headers: { "content-type": contentType, ...cache } });
}

/** Emit one card in the requested format: json, text, or a redirect to its image. */
function renderCard(
	card: Record<string, unknown>,
	format: string,
	face: string,
	version: string,
	pretty: boolean,
	cache: Record<string, string>,
): Response {
	if (format === "text") return textResponse(cardToText(card), "text/plain; charset=utf-8", cache);
	if (format === "image") {
		// `/cards/random` keeps its own `no-cache`: there the variable is WHICH CARD, and an image
		// redirect held for 48 hours would stop it being random. Every other route's image answer
		// takes the image tier. Compared by value rather than by identity so a second `no-cache`
		// caller cannot appear later and quietly get the wrong lifetime.
		const imageCache = cache["Cache-Control"] === RANDOM_CACHE["Cache-Control"] ? cache : IMAGE_CACHE;
		// `face=back` on a card that HAS no back is a 422, not a redirect to the front — measured
		// 2026-08-16 on `/cards/khm/1?format=image&face=back` (Axgard Braggart, layout `normal`):
		// `422 validation_error "This card does not have a second face"`, at a bare `public` tier.
		// That is the opposite of an unrecognized face value, which silently means the front
		// (`&face=sideways` 302s to the front image), so the two cannot share a branch: `back` is a
		// request Scryfall understands and cannot satisfy, `sideways` is one it does not understand.
		if (face === "back" && !Array.isArray(card.card_faces)) {
			return scryfallJson(errorObject("validation_error", 422, NO_SECOND_FACE_DETAILS), pretty, SECOND_FACE_CACHE);
		}
		const location = imageUri(card, version, face);
		if (!location) {
			return scryfallJson(notFoundError("No image is available for this card in that version."), pretty, imageCache);
		}
		// The redirect carries the tier too: the Location is a pure function of the card's id, so
		// an uncached 302 would be a Worker invocation per image load. `text/html` on a bodyless
		// 302 looks like an oversight and is not one — it is what api.scryfall.com sends, and a
		// client comparing responses sees the header whether or not it reads the (empty) body.
		return new Response(null, {
			status: 302,
			headers: { Location: location, "content-type": "text/html; charset=utf-8", ...imageCache },
		});
	}
	return scryfallJson(card, pretty, cache);
}

/** The absolute URL of a route on this host, for `next_page`. */
function selfBaseUrl(ctx: RouteContext, path: string): string {
	const url = new URL(ctx.request.url);
	// The request's own scheme as corrected by the proxy that terminated TLS: a `next_page` a
	// client cannot follow is worse than no pagination at all.
	const scheme = ctx.request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
	return `${scheme}://${ctx.requestHost || url.host}${path}`;
}

/** The base URL every derived `*_uri` in a card object addresses. */
function apiBaseUrl(ctx: RouteContext): string {
	const url = new URL(ctx.request.url);
	const scheme = ctx.request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
	return `${scheme}://${ctx.requestHost || url.host}`;
}

/**
 * Engine failures are LOUD.
 *
 * Upstream falls back to SQL here. This port has none, so an engine that cannot answer must say
 * so rather than 404 — a 404 would tell the client the card does not exist, which is a different
 * and false statement. EngineUnavailableError propagates to dispatch's 503; anything else is a 500
 * in Scryfall's error shape so the client still gets a body it can parse.
 */
function engineFailure(err: unknown, pretty: boolean, query?: string): Response {
	if (err instanceof EngineUnavailableError) throw err;
	// A query the engine REFUSED is the caller's, not the server's: it must not leave here as a
	// 5xx. `query-terms.ts` catches the malformed patterns it can before the engine is asked, so
	// this is the backstop for the ones only Rust's regex crate rejects.
	if (err instanceof EngineQueryError) {
		console.warn("Scryfall compat route: engine refused the query", err.message);
		return scryfallJson(
			badRequestError(query === undefined ? ALL_IGNORED_DETAILS : `Failed to parse query: "${query}"`, null),
			pretty,
			CARDS_CACHE,
		);
	}
	console.error("Scryfall compat route: engine failure", err);
	// `no-store`, NOT the route's tier. Every other status here is deterministic in the URL and
	// safe to cache for hours, but a 500 means the engine failed on this attempt -- caching that
	// alongside the answers would pin a transient outage into every edge for 16 hours.
	return scryfallJson(
		errorObject("internal_error", 500, "The card engine could not answer this request."),
		pretty,
		NO_STORE_HEADER,
	);
}

// ─── GET /cards/search ───────────────────────────────────────────────────────

export async function cardsSearchHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	const q = params.q;
	if (!q?.trim()) return scryfallJson(badRequestError(EMPTY_QUERY_DETAILS, null), pretty, CARDS_CACHE);

	const page = scryfallPage(params.page);

	// SCRYFALL'S IGNORE-AND-CONTINUE POLICY, applied to the raw query before anything reads it:
	// the terms this API cannot honor leave the query carrying a warning, and only a query with
	// NOTHING left is a bad request. See query-terms.ts for the measurements behind every rule.
	const policy = scryfallTermPolicy(q);
	if (policy.unclosedParens) {
		return scryfallJson(badRequestError(UNCLOSED_PARENS_DETAILS, null), pretty, CARDS_CACHE);
	}
	if (policy.allIgnored) {
		return scryfallJson(badRequestError(ALL_IGNORED_DETAILS, policy.warnings), pretty, CARDS_CACHE);
	}
	const warnings: string[] = [...policy.warnings];

	// An unrecognized `unique` is Scryfall's default, SILENTLY: `unique=printing`, `unique=card`,
	// `unique=printings`, `unique=artwork` and `unique=bogus` all come back as the plain
	// unique-by-card answer with no `warnings` key at all (measured 2026-08-16). This port warned
	// on all five — and four of them are its own vocabulary, which the in-query `unique:` directive
	// accepts, so the warning also announced an inconsistency rather than a problem.
	const uniqueRaw = (params.unique ?? "cards").toLowerCase();
	const paramUnique = UNIQUE_MAP[uniqueRaw] ?? "card";

	const orderRaw = (params.order ?? "name").toLowerCase();
	let paramOrderby = ORDER_MAP.get(orderRaw);
	if (paramOrderby === undefined) {
		warnings.push(
			SCRYFALL_ONLY_ORDERS.includes(orderRaw)
				? `This server cannot sort by '${orderRaw}' yet; sorted by name instead.`
				: `Unrecognized order '${orderRaw}'; sorted by name instead.`,
		);
		paramOrderby = "name";
	}

	// An unrecognized direction falls back to AUTO, which is also the default — Scryfall ignores
	// one it does not know rather than erroring.
	const paramDirection = DIRECTION_MAP[(params.dir ?? "auto").toLowerCase()] ?? "auto";

	const engine = await ctx.getEngine();
	const parser = await loadParser();
	let filterTree: unknown;
	let directives: readonly DirectiveFound[] = [];
	// Out of band from the tree on purpose — the rewrite lowers a metacharacter-free regex into a
	// plain literal, and `extrasTriggers` has to tell the two apart. See `Query.loweredRegexTerms`.
	let loweredRegexTerms: readonly LoweredRegexTerm[] = [];
	// And out of band for the same reason one rewrite further along: `expandDerivedPredicates` turns
	// `is:split` into `layout:split`, and only one of those two forces the extras gate.
	let expandedDerivedTerms: readonly ExpandedDerivedTerm[] = [];
	try {
		const parsed = parser.parseWithDirectives(policy.query);
		filterTree = parsed.tree;
		directives = parsed.directives;
		loweredRegexTerms = parsed.loweredRegexTerms;
		expandedDerivedTerms = parsed.expandedDerivedTerms;
		// An `is:` value with no data behind it. The term still filters, so the answer is a
		// no-match — this is what tells the caller that, instead of leaving them to read zero
		// results as "no such card". The 404 body carries `warnings` too (errorObject), so the
		// note survives exactly the case that needs it.
		warnings.push(...parsed.warnings);
	} catch (err) {
		if (parser.isParseError(err)) {
			return scryfallJson(badRequestError(`Failed to parse query: "${q}"`, warnings), pretty, CARDS_CACHE);
		}
		throw err;
	}
	// SCRYFALL'S `include_extras=false` DEFAULT, as a query-time conjunct — which is where
	// Scryfall puts it, and the reason those printings are imported at all now.
	//
	// The exclusion used to be an ABSENCE: `passes_filters` refused memorabilia, un-sets,
	// playtest promos and the "Card" type-line family at import. That cannot reproduce
	// `include_extras`, because there is nothing left to include: `/cards/named?exact=Counters`
	// answered 404 where Scryfall answers fmsc/9, and `include_extras=true` answered nothing at
	// all. Storing the rows and filtering them here answers both.
	//
	// Spelled as `-is:extra` rather than as a set-type conjunct deliberately: `card_is_tags` is a
	// `HybridTagIndex` and composes under `Not`, so `PrintingCompose` survives the extra term;
	// a `SetTypeMatch` conjunct has no narrowing arm and would have cost three of the six
	// physical plans on EVERY query.
	//
	// ── THE AUTO-ENABLE, MEASURED ────────────────────────────────────────────
	//
	// Scryfall does not merely DEFAULT `include_extras` — it FORCES it, overriding an explicit
	// `include_extras=false` in both the echo and the results, whenever the parse tree
	// syntactically contains a trigger term. `extrasTriggers` is that rule; see its own comment
	// for the ranking (57/57 against 20/57 for the set-mention rule this replaces).
	//
	// The `false` branch stays a query-time conjunct rather than a flag on the wire because the
	// caller's own `is:extra` term must keep meaning what it says — see `withoutIsTag`.
	const triggers = extrasTriggers(filterTree, loweredRegexTerms, expandedDerivedTerms);
	let extrasForced = triggers.forced;
	if (!extrasForced && triggers.sets.length > 0) {
		// The one conditional trigger, and the only reason this route ever asks the engine
		// anything before searching: a set term enables extras IFF that set holds one. The table
		// is folded into the archive and cached per store generation, so this is a map lookup on
		// every request after an isolate's first set-scoped query.
		const withExtras = new Set(await engine.setsWithExtras());
		extrasForced = triggers.sets.some((code) => withExtras.has(code));
	}
	// THE VALUE THAT WAS SERVED, which is also the value that is echoed — see `nextPageUrl`.
	const includeExtras = extrasForced || asBool(params.include_extras);
	// ── AND THE SAME STORY FOR `include_variations`, WITH A DIFFERENT TRIGGER RULE ───────────
	//
	// The third of Scryfall's three search parameters, and the last one this route only echoed.
	// Measured 2026-08-16 with queries that fire no auto-enable at all: `t:creature` is 51,473 bare
	// and 51,523 with `include_variations=true`, `cmc=3` 22,832 against 22,854, `o:draw` 12,301
	// against 12,303. So the default EXCLUDES them, exactly as it excludes extras.
	//
	// THE TRIGGER RULE IS NOT THE EXTRAS RULE, which is why this is a separate walk and not a
	// second reading of `triggers`. Every unconditional extras trigger was probed and echoes
	// `include_variations=false`: `a:"rebecca guay" t:creature` and `layout:normal cmc=3` echo
	// `extras=true var=false`, and so do `wm:`, `name:/^z/`, `t:token`, `is:extra`, `is:oversized`,
	// `is:reserved` and `is:rebalanced`. A SET term does not enable it either — `e:hho` is 21 bare
	// and 23 with the parameter, though hho auto-enables extras — so there is no conditional arm
	// here and nothing to ask the engine. The only trigger found is the caller's own `is:variation`,
	// and it is a FORCE like the extras ones: `t:creature or is:variation` sent with
	// `include_variations=false` answers 51,566 and echoes `true`.
	const variationsForced = mentionsIsTag(filterTree, VARIATION_IS_TAG);
	const includeVariations = variationsForced || asBool(params.include_variations);
	filterTree = withoutIsTags(filterTree, [
		...(includeExtras ? [] : [EXTRA_IS_TAG]),
		...(includeVariations ? [] : [VARIATION_IS_TAG]),
	]);

	// Parses, but is a value rather than a filter — see query-validation.ts.
	if (usesValueAsPredicate(filterTree)) {
		return scryfallJson(badRequestError(arithmeticNotComparedMessage(q), warnings), pretty, CARDS_CACHE);
	}

	// THE IN-QUERY DIRECTIVES (upstream #893) REACH THE SEARCH. `parseWithDirectives` has always
	// STRIPPED them from the tree — that is what keeps `unique:prints` from being compiled as a
	// filter leaf — but this route then dropped what it was handed, so a directive was a no-op
	// with the side effect of vanishing: `is:foil e:khm unique:prints` answered the unique-CARDS
	// count (285) where `&unique=prints` answered 387. `/search` folded them from the start
	// (search.ts); only this surface did not.
	//
	// PRECEDENCE IS MEASURED, NOT ASSUMED (api.scryfall.com, 2026-08-16): the DIRECTIVE WINS over
	// the query parameter, in both directions and for every directive —
	// `q=… unique:prints&unique=cards` -> 387 (prints), `q=… unique:cards&unique=prints` -> 285
	// (cards); `q=… order:cmc&order=name` sorts by cmc; `q=… dir:desc&dir=asc` sorts descending.
	// That is exactly `applyDirectives`'s documented rule, so the fold is the shared implementation
	// rather than a second one that could drift from `/search`.
	const folded = applyDirectives(directives, {
		unique: paramUnique,
		prefer: "default",
		orderby: paramOrderby,
		direction: paramDirection,
	});
	const { unique, prefer, orderby, direction } = folded;
	warnings.push(...folded.warnings);

	// ── What `next_page` says about the ordering ─────────────────────────────
	//
	// Scryfall echoes the ordering it SERVED, which is the resolved one in every case but
	// one: an order it recognizes and this server does not (`penny`, `review`) comes back
	// spelled as the client sent it, because Scryfall did sort by it. Echoing `name` there
	// still round-trips on this server — page 2 falls back the same way page 1 did — but it
	// differs from Scryfall for no gain, so the raw spelling is kept.
	//
	// `cubecobra` is the mirror image and the one deliberate deviation: it is THIS project's
	// ordering, Scryfall does not have it and echoes `name`. Echoing `name` here would make
	// `next_page` page 2 by name after page 1 came back by cubecobra — a link that does not
	// round-trip. Serving the order correctly wins over echoing it identically.
	//
	// A directive always beats both: `q=… order:cmc` with no `order=` at all echoes
	// `order=cmc` on api.scryfall.com (measured 2026-08-16).
	const orderEcho =
		orderby === paramOrderby && !ORDER_MAP.has(orderRaw) && SCRYFALL_ONLY_ORDERS.includes(orderRaw)
			? orderRaw
			: orderby;

	// Scryfall echoes `q` LOWERCASED, with whitespace runs collapsed and the ends trimmed.
	// Measured 2026-08-16: `E:KHM T:Creature OR T:Land` -> `e:khm t:creature or t:land`,
	// `a:"Rebecca Guay"` -> `a:"rebecca guay"` (inside the quotes too), `o:/^Whenever/` ->
	// `o:/^whenever/`, `name:Éowyn` -> `name:éowyn` (not ASCII-only), and
	// `_t:creature__cmc>1_` -> `t:creature cmc>1`. Every one of those is the SAME query to
	// this engine as well -- set codes and names are folded at import and the query regexes
	// carry `(?i)` -- so the echo changes the spelling and never the page.
	const qEcho = q.toLowerCase().split(/\s+/).filter(Boolean).join(" ");

	// THE DURABLE OBJECT BUILDS THE WHOLE RESPONSE and this returns it. Splicing the envelope here
	// meant re-enqueuing every chunk of a 652KB page in the metered isolate — ~13ms mean against the
	// free plan's 10ms budget. The only thing left on this side is choosing the shard.
	//
	// next_page is computed up front because it does not depend on the counts: the DO drops it when
	// has_more is false, which is the one fact it needs the counts for.
	try {
		return await engine.scryfallSearchPage(
			{
				filterTreeJson: canonicalStringify(filterTree as FilterValue),
				unique,
				prefer,
				orderby,
				direction: resolveDirection(direction, orderby),
				limit: PAGE_SIZE,
				offset: (page - 1) * PAGE_SIZE,
				fields: [],
				// Always present, never omitted: false IS Scryfall's default (English/canonical
				// printings only), and fixing it on the wire keeps "absent" from meaning anything.
				includeMultilingual: asBool(params.include_multilingual),
			},
			apiBaseUrl(ctx),
			{
				pretty,
				warnings,
				pageOffset: (page - 1) * PAGE_SIZE,
				noMatchDetails: NO_MATCH_DETAILS,
				beyondEndDetails: BEYOND_END_DETAILS,
				// EXACTLY `csv`, lowercase: `format=CSV` serves JSON on api.scryfall.com (measured
				// 2026-08-16), so this comparison is deliberately not case-folded the way `format` is
				// on the single-card routes — which honour `text`/`image` and ignore `csv`, the mirror
				// image of this route. See csv.ts for the whole measured table.
				csv: params.format === "csv",
				nextPageUrl: buildPageUrl(
					selfBaseUrl(ctx, "/cards/search"),
					{
						// EVERY VALUE HERE IS THE RESOLVED ONE, not the raw parameter, because a
						// directive in `q` can have decided it. Measured live 2026-08-16:
						// `q=t:creature order:cmc unique:prints` with NO order/unique parameters
						// echoes `order=cmc&unique=prints`, and `q=t:creature dir:desc` echoes
						// `dir=desc`. `q` itself still echoes verbatim, directive and all — which
						// is why the two must agree: a link that carried `order=name` next to a
						// `q` saying `order:cmc` would page a different result set on page 2.
						//
						// `dir` is the one parameter Scryfall LEAVES OUT of next_page when it
						// resolves to `auto` — verified live 2026-08-16: `?dir=asc` echoes
						// `dir=asc`, `?dir=auto` and no `dir` at all both echo no `dir`. Spelling
						// `dir=auto` in made every paged next_page differ from Scryfall's by one
						// parameter, which a client following the URL verbatim then carries into
						// every later page.
						...(direction === "auto" ? {} : { dir: direction }),
						format: params.format ?? "json",
						// THE RESOLVED VALUE, not the parameter as sent — the same rule `order`
						// and `unique` already follow two lines down. `q=e:lea&include_extras=false`
						// echoes `include_extras=true` on api.scryfall.com AND returns the extras;
						// this echoed `false` while serving with them on, so the link contradicted
						// the page it came from and a client following it verbatim asked for a
						// different result set than it had just been given. Measured 2026-08-16 over
						// 57 set probes plus the unconditional families: the echo agreed with what
						// was served in every single one, which is why "echo = effective value" is
						// the whole rule and the old ledger entry
						// `include-extras-echo-is-the-parameter-as-sent` is deleted rather than
						// amended.
						include_extras: String(includeExtras),
						include_multilingual: String(asBool(params.include_multilingual)),
						include_variations: String(includeVariations),
						order: orderEcho,
						q: qEcho,
						unique: UNIQUE_ECHO[unique],
					},
					page + 1,
				),
			},
			CARDS_CACHE,
		);
	} catch (err) {
		return engineFailure(err, pretty, q);
	}
}

/** What a query's parse tree says about Scryfall's `include_extras` auto-enable. */
interface ExtrasTriggers {
	/** An UNCONDITIONAL trigger term is present: extras are on whatever the caller asked for. */
	forced: boolean;
	/** Lowercased set codes named by `e:`/`s:`/`set:` — the CONDITIONAL trigger. */
	sets: string[];
}

/** Attributes whose mere presence forces `include_extras=true`, whatever their value. */
const UNCONDITIONAL_EXTRAS_ATTRIBUTES: ReadonlySet<string> = new Set([
	"card_artist", // a:
	"card_watermark", // wm:
	"card_layout", // layout:
]);

/**
 * The STORED `is:` values that force extras on — the ones the importer keeps on the row, which
 * survive the rewrite and reach this walk as `card_is_tags` leaves.
 *
 * All 32 were probed for the `include_extras` echo, one query each (2026-08-16, re-run 2026-08-16
 * with the echo read directly). Five fire:
 *
 *   is:extra -> true    is:oversized -> true    is:reserved -> true
 *   is:rebalanced -> true    is:glossy -> true
 *
 * and the other 27 echo false, including the ones that plainly CONTAIN extras and so would look
 * like triggers to a count-based test: `is:variation` is 93 bare against 97 with the flag,
 * `is:convention` 63 against 67, `is:judge` 173 against 176, `is:league` 6 against 18.
 *
 * `glossy` WAS absent, and its absence is the exact hazard of measuring this by counts. The first
 * pass called eight values (buyabox, gameday, giftbox, glossy, …) "unfalsifiable" because they hold
 * no extras, so the flag cannot move their count — but the ECHO moves anyway, because the rule is
 * syntactic. `is:glossy` holds 7 printings and not one of them is `is:extra`, and Scryfall still
 * echoes `include_extras=true` for it. The echo is the measurement; the count never was.
 */
const UNCONDITIONAL_EXTRAS_IS_TAGS: ReadonlySet<string> = new Set([
	EXTRA_IS_TAG,
	"glossy",
	"oversized",
	"reserved",
	"rebalanced",
]);

/**
 * The DERIVED `is:`/`has:` terms that force extras on — the ones `expandDerivedPredicates` replaces
 * with a subtree, so that by the time this walk runs the spelling is gone.
 *
 * IT IS A MEASURED LIST AND NOT A RULE, and the probe was run to find a rule. All 90 values the
 * rewrite expands (77 `is:`, 12 `has:`, 3 `frame:`) were probed one at a time against
 * api.scryfall.com on 2026-08-16 — `<term> or cmc=3` sent with `include_extras=false`, reading the
 * flag back out of the `next_page` echo — and re-probed against a second base (`<term> or t:goblin`)
 * with identical verdicts. Twelve fire; the other 78 do not.
 *
 * EVERY STRUCTURAL HYPOTHESIS IS REFUTED BY THE TABLE, in both directions:
 *
 *  - NOT "what it lowers to". `is:split`, `is:flip`, `is:transform`, `is:tdfc`, `is:meld`,
 *    `is:leveler` and `is:adventure` all lower to `layout:`, which is an unconditional trigger, and
 *    Scryfall fires for none of them. `has:artist` lowers to `artist:/./` and does not fire either.
 *  - NOT "the population contains extras". `is:mdfc` fires with 327 printings and ZERO of them
 *    `is:extra`; `is:glossy` fires with 7 and zero. `is:stamped` does NOT fire with 696 extras out
 *    of 3,195 — the largest extras share in the table.
 *  - NOT the layout family. `is:mdfc` fires while `is:transform` and `is:meld` do not, and `is:dfc`
 *    — which overlaps both — fires. (`is:dfc` is NOT the union of the three, measured separately:
 *    it excludes meld outright and reaches art_series, double_faced_token and reversible_card. See
 *    `DERIVED_EXPANSIONS`. The refutation stands either way; the union was the wrong name for it.)
 *
 * So it is Scryfall's own per-value table, and the honest way to mirror it is to copy it down.
 * Re-derive it by re-running the probe, not by reasoning about the values.
 */
const EXTRAS_DERIVED_TRIGGERS: ReadonlySet<string> = new Set([
	"has:glossy", // == is:glossy, and it fires there too
	"has:watermark", // == is:watermark; `wm:` is an unconditional trigger and this agrees with it
	"is:artseries",
	"is:augmentation",
	"is:dfc",
	"is:funny",
	"is:host",
	"is:mdfc",
	"is:planar",
	"is:reversible",
	"is:token",
	"is:watermark",
]);

/**
 * The `is:` value behind `include_variations`, and the whole of that gate's auto-enable rule.
 *
 * Spelled here rather than imported from `db-info` beside `EXTRA_IS_TAG` because it is not the same
 * kind of thing: `extra` is COMPUTED by this project's import (`COMPUTED_IS_TAGS`), while
 * `variation` is one of Scryfall's own booleans that `BOOLEAN_IS_TAGS` syncs straight off the bulk
 * row. The gate treats them alike; their provenance is not alike.
 */
const VARIATION_IS_TAG = "variation";

/** Whether the parse tree names `is:<tag>` anywhere — under `or`, `and` and negation alike. */
function mentionsIsTag(node: unknown, tag: string): boolean {
	if (!node || typeof node !== "object") return false;
	if (Array.isArray(node)) return node.some((item) => mentionsIsTag(item, tag));
	const n = node as { node_type?: string; kwargs?: Record<string, unknown> };
	if (n.node_type === "CardBinaryOperatorNode") {
		const lhs = n.kwargs?.lhs as { node_type?: string; kwargs?: Record<string, unknown> } | undefined;
		const attr =
			lhs?.node_type === "CardAttributeNode" ? (lhs.kwargs?.attribute_name as string | undefined) : undefined;
		const rhs = n.kwargs?.rhs;
		if (
			attr === "card_is_tags" &&
			Array.isArray(rhs) &&
			rhs.some((v) => typeof v === "string" && v.toLowerCase() === tag)
		) {
			return true;
		}
	}
	return Object.values(n.kwargs ?? {}).some((value) => mentionsIsTag(value, tag));
}

/**
 * Scryfall's `include_extras` AUTO-ENABLE, read off the parse tree.
 *
 * MEASURED, not inferred — ~119 serial probes against api.scryfall.com on 2026-08-16, and the
 * result contradicts the obvious hypothesis. It is NOT a property of the result set: `t:creature`,
 * `o:draw` and `ft:death` each match 1,742 / 358 / 26 extras and every one of them echoes
 * `include_extras=false`. It is a SYNTACTIC property of the terms, propagated through `or`, `and`
 * and negation alike — `e:war or e:lea` is true, `(e:lea t:creature) or t:land` is true even
 * though LEA's only extra is an enchantment that cannot be in that result, `-e:lea t:land` is true
 * and `-e:war t:land` is false. And it is a FORCE, not a default: `include_extras=false` sent
 * explicitly is overridden, in the echo and in the rows.
 *
 * Unconditional triggers: `a:`, `wm:`, `layout:`, `name:/…/`, `t:token`, and four `is:` values
 * (`b:` belongs here too — this parser has no block operator, so the term cannot reach us). Each
 * fires on the TERM: `a:"Wesley Burt"` triggers although `a:"Wesley Burt" is:extra` is 0,
 * `name:/zzzqq/` matches nothing and still triggers, `layout:normal` triggers. Deliberately NOT
 * triggers, each probed: `t:` at any other value, `o:`, `o:/…/`, `t:/…/`, `cn:`, `st:`,
 * `year:`/`date:`, `border:` at every OTHER value, `frame:` at every value, `name:"literal"`, a
 * bare `name:` word, `!"Exact"`, and the other 28 `is:` values — see
 * `UNCONDITIONAL_EXTRAS_IS_TAGS`.
 *
 * `border:silver` WAS in that negative list and is a trigger; it surfaced as a lone outlier in a
 * scope calibration (`border:silver` matching the extras-INCLUDED count where every other scope
 * matched the excluded one) and the obvious explanation — that silver borders are simply extras
 * already — is wrong: only 108 of the 665 are. See the walk for the `border:gold` control.
 *
 * THE DEFAULT IS AN EXCLUSION, RE-MEASURED 2026-08-16 against the claim that it is not. Three
 * queries that cannot trigger any of the above: `t:creature` answers 51,473 bare and 55,454 with
 * `include_extras=true`, `o:draw` 12,301 against 12,858, `cmc=3` 22,832 against 23,477; and
 * `t:goblin cmc=0` — every zero-cost goblin being a token — is 404 bare and 87 with the flag. A
 * SET-SCOPED probe cannot see any of this, which is the trap: `cn:4 s:thob` answers 1 bare because
 * `s:thob` auto-enables, so reconstructing the default from set-scoped counts finds no exclusion
 * and concludes there is none.
 *
 * Conditional trigger: a set term, IFF that set holds at least one `is:extra` printing — see
 * `Engine.setsWithExtras`. Over 18 measured sets the split is perfect (lea/leb/2ed/3ed/sum 1,
 * 4ed/5ed/6ed 2, leg 4, j21 16, hbg 122, unk 506 enable; ust/ice/war/unf/por/7ed are 0 and none
 * does), and six more predicted from the local bulk before being measured were all correct.
 *
 * RANKING on the 57 set probes: this rule 57/57, the `mentionsSet` rule it replaces 20/57 — wrong
 * on every ordinary modern set. Across the non-set probes the old rule additionally missed
 * `name:/…/`, `layout:`, `t:token` and `is:extra`.
 *
 * THE REGEX SPELLING IS INVISIBLE IN THE TREE, which is why `loweredRegexTerms` is a second
 * argument rather than something this walk could find. `lowerLiteralRegexes` rewrites a
 * metacharacter-free regex into a quoted literal before the wire tree exists — upstream's rewrite,
 * compared byte for byte by the parity fixtures, so it is not negotiable — and `name:/zzzqq/` then
 * reads here exactly like `name:"zzzqq"`, `t:/token/` exactly like `t:token`.
 *
 * SCRYFALL SEPARATES BOTH PAIRS, IN OPPOSITE DIRECTIONS, and one cause produces both errors
 * (measured 2026-08-16):
 *
 *   name:/bolt/  175 = its extras-on count   name:"bolt"  157   -> the regex ADDS a trigger
 *   t:token cmc=3  6 (extras auto-on)        t:/token/ cmc=3  0 -> the regex REMOVES one
 *   is:/extra/ cmc=3 and border:/silver/ cmc=3 both answer plain `cmc=3` (22,832), echoing false
 *
 * So a `card_name` term triggers when it was written as a regex whether or not the leaf still is
 * one, and every VALUE-specific trigger fires only when it was NOT. The pairs are keyed by column
 * AND value so `t:token t:/goblin/` still reads its two terms apart; the one case they cannot
 * separate is the same column and value written both ways in one query (`t:token or t:/token/`),
 * where this suppresses and Scryfall triggers — an unreachable spelling in practice, recorded
 * rather than papered over.
 *
 * THE DERIVED SPELLING IS INVISIBLE FOR THE SAME REASON, and `expandedDerivedTerms` is the third
 * argument that restores it. `expandDerivedPredicates` replaces `is:split` with `layout:split`
 * before the wire tree exists — upstream's rewrite again, byte-compared by the same fixtures — and
 * `layout:` is an unconditional trigger while `is:split` is not: 327 there against the 347
 * `layout:split` answers. So the walk declines to fire on any leaf an expansion produced, and
 * `EXTRAS_DERIVED_TRIGGERS` fires instead for the twelve derived TERMS Scryfall does fire on. The
 * two halves are independent — `has:glossy` produces an `is:glossy` leaf that would have fired and
 * must not fire AS a leaf, and fires as a term; `is:split` produces a `layout:` leaf that must not
 * fire either way.
 */
function extrasTriggers(
	tree: unknown,
	loweredRegexTerms: readonly LoweredRegexTerm[] = [],
	expandedDerivedTerms: readonly ExpandedDerivedTerm[] = [],
): ExtrasTriggers {
	// `t:` binds to `card_types` OR `card_subtypes` depending on which vocabulary the value is in,
	// and a term lowered from a regex was bound before that lookup could run — `t:/token/` records
	// `card_types` where the serialized `t:token` reads `card_subtypes`. They are one family here,
	// which costs nothing: the value still has to match.
	const family = (attribute: string) => (attribute === "card_subtypes" ? "card_types" : attribute);
	const lowered = (attribute: string, value: string) =>
		loweredRegexTerms.some((t) => family(t.attribute) === family(attribute) && t.value === value.toLowerCase());
	// Keyed by column AND value for the same reason `lowered` is: `is:split layout:normal` must keep
	// the caller's own `layout:normal` trigger while dropping the `layout:split` the rewrite wrote.
	// The one case it cannot separate is the same column and value written both ways in one query
	// (`is:split layout:split`), where this suppresses — the identical, recorded residual.
	const expandedLeaves = expandedDerivedTerms.flatMap((t) => t.leaves);
	const derived = (attribute: string, value: string) =>
		expandedLeaves.some((t) => family(t.attribute) === family(attribute) && t.value === value.toLowerCase());
	const out: ExtrasTriggers = {
		forced:
			loweredRegexTerms.some((t) => t.attribute === "card_name") ||
			expandedDerivedTerms.some((t) => EXTRAS_DERIVED_TRIGGERS.has(t.term)),
		sets: [],
	};
	walkExtrasTriggers(tree, out, lowered, derived);
	return out;
}

/** Whether a `field:value` term was written as a `field:/regex/` the rewrite lowered. */
type LoweredCheck = (attribute: string, value: string) => boolean;

/**
 * Every string a term's rhs compares against, lowercased — the shapes a value-specific trigger has
 * to read. A type, is-tag or legality leaf serializes to a string array; `layout:`, `border:` and
 * `set:` to a `StringValueNode`; `a:`/`wm:` presence tests to a `RegexValueNode`. Anything else
 * (numeric, mana) has no string to compare and yields nothing.
 */
function termValues(rhs: unknown): string[] {
	if (Array.isArray(rhs)) return rhs.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase());
	const value = (rhs as { kwargs?: { value?: unknown } })?.kwargs?.value;
	return typeof value === "string" ? [value.toLowerCase()] : [];
}

function walkExtrasTriggers(node: unknown, out: ExtrasTriggers, lowered: LoweredCheck, derived: LoweredCheck): void {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) walkExtrasTriggers(item, out, lowered, derived);
		return;
	}
	const n = node as { node_type?: string; kwargs?: Record<string, unknown> };
	if (n.node_type === "CardBinaryOperatorNode") {
		const lhs = n.kwargs?.lhs as { node_type?: string; kwargs?: Record<string, unknown> } | undefined;
		const attr =
			lhs?.node_type === "CardAttributeNode" ? (lhs.kwargs?.attribute_name as string | undefined) : undefined;
		const rhs = n.kwargs?.rhs;
		// A term every one of whose values a derived expansion put there is not a term the caller
		// wrote, and Scryfall's rule reads what was written. `is:split` is the whole class: it leaves
		// a `layout:split` behind, `layout:` is an unconditional trigger, and `is:split` is not one.
		const values = termValues(rhs);
		const fromExpansion = values.length > 0 && values.every((v) => attr !== undefined && derived(attr, v));
		if (attr && UNCONDITIONAL_EXTRAS_ATTRIBUTES.has(attr) && !fromExpansion) out.forced = true;
		if (attr === "card_name" && (rhs as { node_type?: string })?.node_type === "RegexValueNode" && !fromExpansion) {
			out.forced = true;
		}
		// `t:token` and four `is:` values are the VALUE-specific triggers; both arrive as a string
		// array (the parser expands a type or is-tag term into its comparison keys).
		// `banned:` at ANY value, and `f:`/`format:`/`legal:` at exactly `premodern`. Both bind to
		// `card_legalities`, so the alias is what separates them — `banned:legacy`, `banned:vintage`,
		// `banned:modern` and `banned:pauper` all echo true while `restricted:vintage` echoes false,
		// and of the 21 format values probed one at a time `premodern` is the ONLY one that fires
		// (`legal:premodern` and `-f:premodern t:land` fire too, so it is the value and not the
		// alias, and negation does not cancel it). Measured 2026-08-16.
		// `-banned:commander` is the tail of `is:commander`'s expansion, so this is one of the four
		// triggers a derived term can leak: `is:commander` echoes false there and would fire here.
		if (attr === "card_legalities" && !fromExpansion) {
			const original = lhs?.kwargs?.original_attribute;
			if (original === "banned") out.forced = true;
			if (values.includes("premodern")) out.forced = true;
		}
		if (attr === "card_types" || attr === "card_subtypes" || attr === "card_is_tags") {
			const wanted = (v: string) => (attr === "card_is_tags" ? UNCONDITIONAL_EXTRAS_IS_TAGS.has(v) : v === "token");
			if (values.some((v) => wanted(v) && !lowered(attr, v) && !derived(attr, v))) {
				out.forced = true;
			}
		}
		// `border:silver` — a VALUE-specific trigger on an attribute that is otherwise inert, and
		// the one term in this rule with a perfect control. `border:gold` is 0 bare and 1,373 with
		// `include_extras=true` (every gold border is a World Championship card, so the whole
		// population is memorabilia), which is what a NON-trigger on the same attribute looks like;
		// `border:silver` is 665 bare and 665 with the flag, echoing `include_extras=true` unsent,
		// with 108 of those 665 inside `is:extra`. `border:black`, `border:white` and
		// `border:borderless` echo false, as does `frame:` at every value. Measured 2026-08-16.
		if (attr === "card_border") {
			for (const value of values) {
				if (value === "silver" && !lowered(attr, value) && !derived(attr, value)) out.forced = true;
			}
		}
		if (attr === "card_set_code" && !fromExpansion) {
			for (const value of values) out.sets.push(value);
		}
	}
	for (const value of Object.values(n.kwargs ?? {})) walkExtrasTriggers(value, out, lowered, derived);
}

/**
 * `tree AND NOT is:<tag> AND NOT is:<tag>…` — the default-lane exclusions, built as tree nodes
 * rather than by rewriting the query string so a caller's own `is:extra` / `is:variation` term
 * still means what it says.
 *
 * Two gates feed this, and BOTH can be closed at once: `include_extras` contributes `is:extra` and
 * `include_variations` contributes `is:variation`. They are independent on Scryfall — `t:creature`
 * is 51,473 bare, 55,454 with extras alone, 51,523 with variations alone and 55,506 with both — so
 * the conjuncts are independent here too. They arrive as ONE flat `AndNode` rather than as nested
 * wraps because a second wrap would bury the caller's own tree an operand deeper for nothing;
 * `card_is_tags` is a `HybridTagIndex` that survives `Not`, so each term costs a narrowing arm and
 * not a physical plan the way a `SetTypeMatch` conjunct would.
 *
 * A `TrueNode` tree (the empty query, and every route that searches without one) is left ALONE:
 * those lanes have their own scoping, and wrapping `True` would change what `/cards/random` and
 * the collection lookups answer.
 */
function withoutIsTags(tree: unknown, tags: readonly string[]): unknown {
	if (tags.length === 0) return tree;
	if (!tree || typeof tree !== "object" || (tree as { node_type?: string }).node_type === "TrueNode") return tree;
	return {
		node_type: "AndNode",
		kwargs: {
			operands: [
				tree,
				...tags.map((tag) => ({
					node_type: "NotNode",
					kwargs: {
						operand: {
							node_type: "CardBinaryOperatorNode",
							kwargs: {
								lhs: {
									node_type: "CardAttributeNode",
									kwargs: { attribute_name: "card_is_tags", original_attribute: "is" },
								},
								op: ":",
								rhs: [tag],
							},
						},
					},
				})),
			],
		},
	};
}

// ─── GET /cards/named ────────────────────────────────────────────────────────

export async function cardsNamedHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	const exact = params.exact;
	const fuzzy = params.fuzzy;
	if (!exact && !fuzzy) {
		return scryfallJson(badRequestError(NAMED_MISSING_PARAM_DETAILS), pretty, CARDS_CACHE);
	}
	const format = (params.format ?? "json").toLowerCase();
	const face = params.face ?? "front";
	const version = params.version ?? DEFAULT_IMAGE_VERSION;
	const setCode = params.set ?? "";
	const engine = await ctx.getEngine();
	const baseUrl = apiBaseUrl(ctx);

	if (exact) {
		// Folded here, matched against the stored `card_name_folded` — Scryfall's exact match
		// ignores case AND diacritics, and resolves a single face of a "Front // Back" card.
		let card: Record<string, unknown> | null;
		try {
			card = await engine.scryfallExactName(foldAccents(exact.trim().toLowerCase()), setCode, baseUrl);
		} catch (err) {
			return engineFailure(err, pretty);
		}
		if (!card) return scryfallJson(notFoundError(`No cards found matching “${exact}”`), pretty, CARDS_CACHE);
		return renderCard(card, format, face, version, pretty, CARDS_CACHE);
	}

	return namedFuzzy(engine, fuzzy ?? "", setCode, baseUrl, { format, face, version, pretty });
}

/**
 * Resolve a fuzzy name: exact, then typo-tolerant similarity, then all-words-present.
 *
 * The three stages mirror what Scryfall resolves in practice — `lightning bolt` exactly,
 * `lihgtning bolt` by typo distance, `bolt` by containment — and each stage that finds more than
 * one distinct card name reports `ambiguous` rather than guessing between them.
 *
 * TYPO BEFORE CONTAINMENT, and the order is load-bearing. `fuzzy=primeval titanoth` is the proof
 * in one needle: containment answers `Titanoth Rex` (its FLAVOR name carries "primeval", its
 * oracle name carries "titanoth") and api.scryfall.com answers `Primeval Titan`, which only the
 * typo stage can produce. Six more needles move the same way — `sol rin`, `ightning bolt`,
 * `austere`, `ancestral`, `counter`, `countersp` — all of which containment-first calls
 * `ambiguous` or resolves to the wrong card. The reorder is only correct alongside the metric it
 * shipped with (card_engine's `Fuzzy name matching` module comment): on the OLD pg_trgm score
 * this order turned `bolt` and `jac bel`, which Scryfall calls ambiguous, into hits.
 */
async function namedFuzzy(
	engine: Engine,
	fuzzy: string,
	setCode: string,
	baseUrl: string,
	render: { format: string; face: string; version: string; pretty: boolean },
): Promise<Response> {
	const { pretty } = render;
	const needle = foldAccents(fuzzy.trim().toLowerCase());
	const words = needle.split(/[^\w']+/u).filter((w) => w.length > 0);
	if (words.length === 0) {
		return scryfallJson(badRequestError(NAMED_MISSING_PARAM_DETAILS), pretty, CARDS_CACHE);
	}

	try {
		const exactHit = await engine.scryfallExactName(needle, setCode, baseUrl);
		if (exactHit) return renderCard(exactHit, render.format, render.face, render.version, pretty, CARDS_CACHE);

		const { status, card } = await engine.scryfallFuzzyName(needle, baseUrl);
		if (status === "ambiguous") return ambiguous(fuzzy, pretty);
		if (status === "hit" && card)
			return renderCard(card, render.format, render.face, render.version, pretty, CARDS_CACHE);

		// Two is all it takes to tell "one match" from "ambiguous"; asking for more would scan the
		// same corpus to throw the rest away.
		const contained = await engine.scryfallNamesContaining(words, setCode, 2, baseUrl);
		if (contained.length > 1) return ambiguous(fuzzy, pretty);
		const only = contained[0];
		if (only) return renderCard(only, render.format, render.face, render.version, pretty, CARDS_CACHE);
	} catch (err) {
		return engineFailure(err, pretty);
	}
	return scryfallJson(notFoundError(`No cards found matching “${fuzzy}”`), pretty, CARDS_CACHE);
}

/**
 * Scryfall's ambiguous answer, which is a `not_found` CARRYING a type — measured on
 * api.scryfall.com 2026-08-16, `fuzzy=aust com`:
 *
 *   {"object":"error","code":"not_found","type":"ambiguous","status":404,
 *    "details":"Too many cards match ambiguous name “aust com”. Add more words to refine your search."}
 *
 * The mirror answered `"code":"ambiguous"` with no `type`, which is the same 404 with a different
 * body — the whole of the `named-fuzzy-aust-com` live-parity deviation once both sides agreed the
 * name was ambiguous. `code` stays the coarse class ("this resolved to no one card") and `type`
 * carries the refinement, which is Scryfall's split, not this port's.
 */
function ambiguous(name: string, pretty: boolean): Response {
	const error: ScryfallError = {
		object: "error",
		code: "not_found",
		// Scryfall's own key position, between `code` and `status`.
		type: "ambiguous",
		status: 404,
		details: `Too many cards match ambiguous name “${name}”. Add more words to refine your search.`,
	};
	return scryfallJson(error, pretty, CARDS_CACHE);
}

// ─── GET /cards/autocomplete ─────────────────────────────────────────────────

export async function cardsAutocompleteHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	const needle = (params.q ?? "").trim();
	// Scryfall answers an empty catalog below two characters rather than scanning for one letter.
	if (needle.length < 2) return scryfallJson(catalogObject([]), pretty, CARDS_CACHE);
	const engine = await ctx.getEngine();
	try {
		// FOLDED, matching what the engine now compares against. Unfolded, an ASCII query could not
		// reach a name carrying diacritics: `q=eowyn` answered an EMPTY catalog while `q=éowyn`
		// answered three cards, and `jotun` and `lim-dul` answered nothing. Scryfall returns 3, 3
		// and 8 for those. The `name:` search path has folded here since #649 (card-query-nodes);
		// this route simply never did.
		const names = await engine.scryfallAutocomplete(foldAccents(needle.toLowerCase()), MAX_AUTOCOMPLETE_VALUES);
		return scryfallJson(catalogObject(names), pretty, CARDS_CACHE);
	} catch (err) {
		return engineFailure(err, pretty);
	}
}

// ─── GET /cards/random ───────────────────────────────────────────────────────

export async function cardsRandomHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	const format = (params.format ?? "json").toLowerCase();
	const engine = await ctx.getEngine();
	const baseUrl = apiBaseUrl(ctx);
	const q = params.q;

	let filterTreeJson = TRUE_TREE;
	if (q?.trim()) {
		// The same ignore-and-continue policy `/cards/search` runs, because Scryfall runs it here
		// too: `/cards/random?q=subtype:elf` is a 400 "All of your terms were ignored." and not a
		// random elf (measured 2026-08-16). A random card drawn from a query whose only term was
		// silently dropped is a random card from the WHOLE corpus, which is the worst of the
		// available answers.
		const policy = scryfallTermPolicy(q);
		if (policy.unclosedParens) {
			return scryfallJson(badRequestError(UNCLOSED_PARENS_DETAILS, null), pretty, RANDOM_CACHE);
		}
		if (policy.allIgnored) {
			return scryfallJson(badRequestError(ALL_IGNORED_DETAILS, policy.warnings), pretty, RANDOM_CACHE);
		}
		const parser = await loadParser();
		let tree: unknown;
		try {
			tree = parser.parseWithDirectives(policy.query).tree;
		} catch (err) {
			if (parser.isParseError(err)) {
				return scryfallJson(badRequestError(`Failed to parse query: "${q}"`), pretty, RANDOM_CACHE);
			}
			throw err;
		}
		// Parses, but is a value rather than a filter — see query-validation.ts.
		if (usesValueAsPredicate(tree)) {
			return scryfallJson(badRequestError(arithmeticNotComparedMessage(q)), pretty, RANDOM_CACHE);
		}
		filterTreeJson = canonicalStringify(tree as FilterValue);
	}

	try {
		// Two passes, like upstream: count, then take one card at a random offset. A sort over the
		// whole match set to keep one row would be the alternative, and it is strictly worse.
		const counted = await engine.scryfallSearch(
			{
				filterTreeJson,
				unique: "card",
				prefer: "default",
				orderby: "name",
				direction: "asc",
				limit: 1,
				offset: 0,
				fields: [],
			},
			baseUrl,
		);
		// Scryfall words the random miss differently from the search miss, and says the thing this
		// route is actually unable to do (measured 2026-08-16 on `/cards/random?q=e:notaset`).
		if (counted.totalCards === 0) return scryfallJson(notFoundError(RANDOM_NO_MATCH_DETAILS), pretty, RANDOM_CACHE);

		const offset = Math.floor(Math.random() * counted.totalCards);
		const drawn = await engine.scryfallSearch(
			{
				filterTreeJson,
				unique: "card",
				prefer: "default",
				orderby: "name",
				direction: "asc",
				limit: 1,
				offset,
				fields: [],
			},
			baseUrl,
		);
		// The one place this surface genuinely needs the card as an object: /cards/random reshapes a
		// single card into text or an image redirect. One card, so decoding it costs nothing that
		// matters -- unlike a 175-card page, which is why the list routes never do this.
		const cards = JSON.parse(new TextDecoder().decode(drawn.cardsBytes)) as Record<string, unknown>[];
		const card = cards[0];
		if (!card) return scryfallJson(notFoundError(RANDOM_NO_MATCH_DETAILS), pretty, RANDOM_CACHE);
		// RANDOM_CACHE carries Scryfall's `no-cache` -- a cached random card is one card forever,
		// and every draw has to reach the engine.
		return renderCard(
			card,
			format,
			params.face ?? "front",
			params.version ?? DEFAULT_IMAGE_VERSION,
			pretty,
			RANDOM_CACHE,
		);
	} catch (err) {
		return engineFailure(err, pretty);
	}
}

// ─── POST /cards/collection ──────────────────────────────────────────────────

export async function cardsCollectionHandler(
	ctx: RouteContext,
	_positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	let body: unknown;
	try {
		body = await ctx.request.json();
	} catch {
		body = null;
	}
	const identifiers = (body as { identifiers?: unknown } | null)?.identifiers;
	// Two SEPARATE complaints, and which one you get depends on whether `identifiers` was there at
	// all — measured 2026-08-16: `{}` answers the COUNT sentence (an absent list is an empty one),
	// `{"identifiers": {}}` answers the ARRAY one. Both are `400 bad_request`, not the `422
	// validation_error` this port sent with wording of its own; a client string-matching Scryfall's
	// messages saw neither.
	if (identifiers !== undefined && !Array.isArray(identifiers)) {
		return scryfallJson(badRequestError(COLLECTION_NOT_AN_ARRAY_DETAILS), pretty, COLLECTION_REFUSED_CACHE);
	}
	// The count rule covers MORE than the count: an empty list, a missing list, a list past 75, AND
	// a list holding anything that is not an object all answer this one sentence (`[null]` and
	// `["Lightning Bolt"]` both measured). Scryfall validates the list's SHAPE here and the
	// identifiers' shape afterwards, so an entry that is not an object never reaches the schema
	// check — which is why `collectionIdentifierError` no longer has a branch for one.
	if (
		identifiers === undefined ||
		identifiers.length === 0 ||
		identifiers.length > MAX_COLLECTION_IDENTIFIERS ||
		identifiers.some((ident) => typeof ident !== "object" || ident === null || Array.isArray(ident))
	) {
		return scryfallJson(badRequestError(COLLECTION_COUNT_DETAILS), pretty, COLLECTION_REFUSED_CACHE);
	}

	// Validation runs over the WHOLE batch before anything is resolved: Scryfall's answer to a
	// malformed identifier is one 400 for the request, not a per-identifier miss, so a batch that
	// carries one must not cost an engine round trip either.
	const malformed = collectionIdentifierError(identifiers);
	if (malformed) return scryfallJson(malformed, pretty, COLLECTION_REFUSED_CACHE);

	const engine = await ctx.getEngine();
	const baseUrl = apiBaseUrl(ctx);
	try {
		const resolved = await resolveIdentifiers(engine, identifiers, baseUrl);
		const found: Record<string, unknown>[] = [];
		const notFound: unknown[] = [];
		for (let at = 0; at < identifiers.length; at++) {
			const card = resolved[at];
			// ONE ENTRY PER IDENTIFIER, duplicates included. This port deduplicated by card id, which
			// looks like a courtesy and breaks the response's contract: `data` is the answer to the
			// list the client sent, and a client that submitted a deck list with four copies of a
			// card got three fewer objects back than it had rows to fill. Measured 2026-08-16 —
			// three identical `{id}` identifiers return three card objects, and 75 identical `{name}`
			// identifiers return 75 (441KB of them).
			if (card) found.push(card);
			else notFound.push(identifiers[at]);
		}
		return scryfallJson(collectionList(found, notFound), pretty, COLLECTION_CACHE);
	} catch (err) {
		return engineFailure(err, pretty);
	}
}

/**
 * Resolve every collection identifier, batching by kind.
 *
 * Batched rather than looped because each lookup is a Durable Object RPC: 75 identifiers resolved
 * one at a time would be 75 round trips. Every kind that is a query becomes a filter tree here and
 * goes over in one call; the id-shaped kinds go over in one call each.
 */
async function resolveIdentifiers(
	engine: Engine,
	identifiers: unknown[],
	baseUrl: string,
): Promise<(Record<string, unknown> | null)[]> {
	const out: (Record<string, unknown> | null)[] = new Array(identifiers.length).fill(null);
	const byScryfallId: { at: number; id: string }[] = [];
	const byTree: { at: number; tree: string }[] = [];
	// The remaining kinds each need their own engine entry point, so they are gathered per kind
	// and awaited together rather than serialized.
	const singles: Promise<void>[] = [];

	for (let at = 0; at < identifiers.length; at++) {
		const ident = identifiers[at];
		if (typeof ident !== "object" || ident === null) continue;
		const id = ident as Record<string, unknown>;
		const put = (p: Promise<Record<string, unknown> | null>) => {
			singles.push(
				p.then((card) => {
					out[at] = card;
				}),
			);
		};

		if (typeof id.id === "string" && isUuid(id.id)) {
			byScryfallId.push({ at, id: id.id });
		} else if (typeof id.oracle_id === "string" && isUuid(id.oracle_id)) {
			put(engine.scryfallCardByOracleId(id.oracle_id, baseUrl));
		} else if (typeof id.illustration_id === "string" && isUuid(id.illustration_id)) {
			put(engine.scryfallCardByIllustrationId(id.illustration_id, baseUrl));
		} else if (id.mtgo_id !== undefined) {
			const n = asInt(String(id.mtgo_id));
			if (n !== undefined) put(engine.scryfallCardByExternalId("mtgo", n, baseUrl));
		} else if (id.multiverse_id !== undefined) {
			const n = asInt(String(id.multiverse_id));
			if (n !== undefined) put(engine.scryfallCardByExternalId("multiverse", n, baseUrl));
		} else if (id.set !== undefined && id.collector_number !== undefined) {
			byTree.push({ at, tree: setAndCollectorNumber(String(id.set), String(id.collector_number)) });
		} else if (id.name !== undefined) {
			byTree.push({ at, tree: cardName(String(id.name), id.set === undefined ? undefined : String(id.set)) });
		}
	}

	if (byScryfallId.length > 0) {
		singles.push(
			engine
				.scryfallCardsByIds(
					byScryfallId.map((e) => e.id),
					baseUrl,
				)
				.then((cards) => {
					// The batch skips misses, so results are matched back BY ID rather than by position.
					const byId = new Map(cards.map((c) => [String(c.id).toLowerCase(), c]));
					for (const { at, id } of byScryfallId) out[at] = byId.get(id.toLowerCase()) ?? null;
				}),
		);
	}
	if (byTree.length > 0) {
		singles.push(
			engine
				.scryfallFirstOfEach(
					byTree.map((e) => e.tree),
					baseUrl,
				)
				.then((cards) => {
					for (let i = 0; i < byTree.length; i++) {
						const entry = byTree[i];
						if (entry) out[entry.at] = cards[i] ?? null;
					}
				}),
		);
	}

	await Promise.all(singles);
	return out;
}

// ─── GET /cards and /cards/... ───────────────────────────────────────────────

/**
 * Every `/cards/*` shape the five named sub-routes do not claim, dispatched by segment count:
 *
 *   - `/cards`                            every card, paginated
 *   - `/cards/:id`                        one card by Scryfall id
 *   - `/cards/:namespace/:id`             one card by multiverse/mtgo/arena/tcgplayer/cardmarket id
 *   - `/cards/:code/:number`              one card by set code and collector number
 *   - `/cards/:code/:number/:lang`        the same, in one language
 *   - `/cards/:id/rulings`, `/cards/:namespace/:id/rulings`, `/cards/:code/:number/rulings`
 *                                        that card's rulings, as a List of Ruling objects
 */
export async function cardsHandler(
	ctx: RouteContext,
	positionalArgs: string[],
	params: Record<string, string>,
): Promise<Response> {
	const pretty = asBool(params.pretty);
	const [identifier = "", number = "", suffix = ""] = positionalArgs;

	if (!identifier) return allCardsPage(ctx, params, pretty);

	// The rulings variants address a card exactly the way every other shape here does, so the
	// segment is consumed and the rest resolved as a plain card address. The card still has to be
	// found: rulings for a card this deployment does not hold are Scryfall's 404, not an empty
	// list, which would be a claim about the card rather than about the corpus.
	const wantsRulings = number === "rulings" || suffix === "rulings";

	// Which miss body this path gets if nothing resolves — Scryfall words them by SHAPE, not by
	// outcome, so it is decided from the segments rather than from the lookup.
	//
	// `/cards/<x>/rulings` where x is not an id is the subtle one: Scryfall reads it as a set code
	// and a collector number called "rulings", so it answers the CARD miss rather than the rulings
	// one. Measured, both ways.
	//
	// The SHAPE test is the V4 one (`COLLECTION_UUID_RE`), not the loose hex-and-dashes `UUID_RE`,
	// and the difference is measured (api.scryfall.com, 2026-08-16, one request per row):
	//
	//   /cards/00000000-0000-4000-8000-000000000000   card miss   `public, max-age=57600`
	//   /cards/00000000-0000-0000-0000-000000000001   route miss  `max-age=57600`
	//   /cards/3f2c8e5d-91b7-1a6e-bd12-4f5a9c7e8b01   route miss  `max-age=57600`
	//   /cards/not-a-uuid                             route miss  `max-age=57600`
	//   /cards/tcgplayer/999999999                    card miss   `public, max-age=57600`
	//
	// So a v1 UUID is not a card ADDRESS at Scryfall — it is a path that names nothing, and it gets
	// the generic sentence and the tier that goes with it. This port read the same segment with the
	// loose rule and answered "No card found…" to all four of the non-v4 rows, telling a client that
	// a card it had asked for does not exist when what did not exist was the address.
	const addressesNothing = !number && !COLLECTION_UUID_RE.test(identifier);
	const rulingsShape = (number === "rulings" && isUuid(identifier)) || suffix === "rulings";
	const missDetails = addressesNothing
		? NOT_FOUND_DETAILS
		: rulingsShape
			? RULINGS_NOT_FOUND_DETAILS
			: CARD_NOT_FOUND_DETAILS;
	// The two 404s carry DIFFERENT tiers, and the split is the same one: a miss about the CARD keeps
	// the route's `public` tier, a miss about the PATH drops `public` and keeps only the max-age.
	const missCache = addressesNothing ? PATH_MISS_CACHE : CARDS_CACHE;

	let card: Record<string, unknown> | null;
	try {
		card = await resolvePathCard(ctx, identifier, number, suffix, wantsRulings);
	} catch (err) {
		return engineFailure(err, pretty);
	}

	if (!card) return scryfallJson(notFoundError(missDetails), pretty, missCache);
	if (wantsRulings) return rulingsForCard(ctx, card, pretty);
	return renderCard(
		card,
		(params.format ?? "json").toLowerCase(),
		params.face ?? "front",
		params.version ?? DEFAULT_IMAGE_VERSION,
		pretty,
		CARDS_CACHE,
	);
}

/**
 * The card a `/cards/...` path addresses, or null when it addresses nothing — an unparseable id,
 * a language no printing carries, or a genuine miss, all of which are the same 404.
 *
 * Split out because the rulings variants resolve their card through it too, which is upstream's
 * `_resolve_path_card` and matters for more than tidiness: the rulings routes accept exactly the
 * addressings the card routes do, and one resolver is what keeps that true.
 */
async function resolvePathCard(
	ctx: RouteContext,
	identifier: string,
	number: string,
	suffix: string,
	wantsRulings: boolean,
): Promise<Record<string, unknown> | null> {
	// Drop the trailing `rulings` so the rest reads as a plain card address. When it was the
	// SECOND segment the path was `/cards/:id/rulings`, and there is no third segment to keep.
	if (wantsRulings) {
		if (suffix === "rulings") suffix = "";
		else number = suffix = "";
	}

	const engine = await ctx.getEngine();
	const baseUrl = apiBaseUrl(ctx);

	if ((EXTERNAL_ID_NAMESPACES as readonly string[]).includes(identifier)) {
		const externalId = asInt(number);
		if (externalId === undefined) return null;
		return engine.scryfallCardByExternalId(identifier, externalId, baseUrl);
	}
	if (!number) {
		if (!isUuid(identifier)) return null;
		return engine.scryfallCardById(identifier, baseUrl);
	}
	// The language is part of the query, like upstream's SQL filter: `card_lang` is a filter
	// column, and the segment defaults to English exactly as Scryfall defaults it. A language no
	// printing carries resolves nothing, which is the same 404 as any other miss.
	const [first] = await engine.scryfallFirstOfEach(
		[setAndCollectorNumber(identifier, number, suffix || "en")],
		baseUrl,
	);
	return first ?? null;
}

/** `[]` as bytes: the `data` of a card that has no rulings, which is a 200 rather than a miss. */
const EMPTY_DATA = encodeUtf8("[]");

/** Scryfall's own wording is not available for this one — it never has to say it. */
const RULINGS_UNPUBLISHED_DETAILS =
	"This server has not published its rulings data yet. Try again after the next import.";
const RULINGS_UNREADABLE_DETAILS = "The rulings store could not be read.";

/**
 * One card's rulings, as a List of Ruling objects.
 *
 * Rulings hang off `oracle_id`, so every printing of a card answers with the same list — which is
 * why they are stored by oracle id rather than per printing. The bucket that holds them is read
 * from KV and SLICED, never parsed: see src/engine/rulings-kv.ts for the layout and for why this
 * is the one `/cards/*` answer the Durable Object has no part in.
 */
async function rulingsForCard(ctx: RouteContext, card: Record<string, unknown>, pretty: boolean): Promise<Response> {
	const oracleId = typeof card.oracle_id === "string" ? card.oracle_id : "";
	const bucket = oracleId ? rulingsBucketOf(oracleId) : null;
	// A card carrying no usable oracle id has no rulings to find. Upstream answers the same empty
	// List rather than a miss — the card itself resolved, so the 404 would be about the wrong thing.
	if (bucket === null) return scryfallListJson(EMPTY_DATA, { hasMore: false }, pretty, CARDS_CACHE);

	let value: ArrayBuffer | null;
	try {
		value = await ctx.env.STORE_KV.get(rulingsBucketKey(bucket), "arrayBuffer");
	} catch (err) {
		console.error("Rulings: KV read failed", err);
		return scryfallJson(errorObject("internal_error", 500, RULINGS_UNREADABLE_DETAILS), pretty, NO_STORE_HEADER);
	}
	// Every bucket is published, empty ones included, so a MISSING bucket means no import has put
	// rulings in this namespace yet — not that the card has none. Saying so is the honest answer;
	// `data: []` would be a claim about the card, and a 404 a claim about its existence.
	if (value === null) {
		return scryfallJson(errorObject("service_unavailable", 503, RULINGS_UNPUBLISHED_DETAILS), pretty, NO_STORE_HEADER);
	}

	let data: Uint8Array;
	try {
		data = rulingsSlice(new Uint8Array(value), oracleId) ?? EMPTY_DATA;
	} catch (err) {
		if (!(err instanceof RulingsFormatError)) throw err;
		console.error(`Rulings: ${rulingsBucketKey(bucket)} is not readable as a bucket`, err);
		return scryfallJson(errorObject("internal_error", 500, RULINGS_UNREADABLE_DETAILS), pretty, NO_STORE_HEADER);
	}
	return scryfallListJson(data, { hasMore: false }, pretty, CARDS_CACHE);
}

/** One page of the unfiltered `/cards` listing, ordered by name like Scryfall's. */
async function allCardsPage(ctx: RouteContext, params: Record<string, string>, pretty: boolean): Promise<Response> {
	// The same never-rejecting `page` as /cards/search — one rule, because it is one parameter.
	const page = scryfallPage(params.page);
	const engine = await ctx.getEngine();
	// Same pattern as /cards/search: the Durable Object builds the whole response and this returns
	// it, so the metered isolate never touches the 663KB page.
	try {
		return await engine.scryfallSearchPage(
			{
				filterTreeJson: TRUE_TREE,
				unique: "printing",
				prefer: "default",
				orderby: "name",
				direction: "asc",
				limit: PAGE_SIZE,
				offset: (page - 1) * PAGE_SIZE,
				fields: [],
			},
			apiBaseUrl(ctx),
			{
				pretty,
				pageOffset: (page - 1) * PAGE_SIZE,
				noMatchDetails: NO_MATCH_DETAILS,
				beyondEndDetails: BEYOND_END_DETAILS,
				nextPageUrl: buildPageUrl(selfBaseUrl(ctx, "/cards"), {}, page + 1),
			},
			CARDS_CACHE,
		);
	} catch (err) {
		return engineFailure(err, pretty);
	}
}

export type { ScryfallError };
