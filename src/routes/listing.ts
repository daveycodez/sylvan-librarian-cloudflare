// The {doc, args, kwargs} entries served in upstream's 404 routes listing
// (_build_routes_listing, api_resource.py:465-513), hand-mirrored from what
// Python inspect produces for each handler:
//   - doc: the handler's raw __doc__ (indentation preserved);
//   - args: positional-or-keyword and keyword-only parameters WITHOUT
//     defaults, excluding self/falcon_response and names starting with "_";
//   - kwargs: parameters WITH defaults, as {type, default};
//   - types: the literal annotation strings (api_resource.py uses
//     `from __future__ import annotations`, so _get_type_name falls through to
//     str(annotation)); defaults serialize through json.dumps(default=str),
//     which renders StrEnum defaults as their lowercase values.

import type { RouteEntry } from "./registry";

type Listing = RouteEntry["listing"];

const noParams = (doc: string): Listing => ({ doc, args: [], kwargs: {} });

const SERVE_FILE_DOC = (filename: string): string =>
	`Return the ${filename} file.

        Args:
        ----
            falcon_response (falcon.Response): The Falcon response to write to.
        `;

export const LISTINGS = {
	get_pid: noParams(
		`Just return the pid of the process which served this request.

        Returns:
        -------
            int: The process ID.

        `,
	),

	setup_schema: noParams("Set up the database schema and apply migrations as needed."),

	import_data: noParams("Import data from Scryfall and insert into the database."),

	search: {
		doc: `Run a search query and return results and metadata.

        Args:
            falcon_response: The Falcon response object (unused).
            q: Query string (alternative to query parameter).
            query: Query string (alternative to q parameter).
            direction: Sort direction ('asc' or 'desc').
            fields: Which fields to return per card (comma-separated in the query string). Defaults
                to the usual 9 (name, set_code, collector_number, power, toughness, mana_cost,
                oracle_text, set_name, type_line). See RESULT_FIELD_COLUMNS for the full vocabulary.
            limit: Maximum number of results to return.
            orderby: Field to sort by.
            shape: Shape of the "cards" list: 'rows' (list of card objects, default) or
                'columnar' (one list per field, keyed by field name — smaller on the wire).
            unique: Unique on field.
            prefer: Prefer order (oldest, newest, usd-low, usd-high, promo).

        Returns:
            Dict containing search results and metadata.
        `,
		args: [],
		kwargs: {
			direction: { type: "SortDirection", default: "asc" },
			fields: { type: "Sequence[str] | None", default: null },
			limit: { type: "int", default: 100 },
			orderby: { type: "CardOrdering", default: "edhrec" },
			prefer: { type: "PreferOrder", default: "default" },
			q: { type: "str | None", default: null },
			query: { type: "str | None", default: null },
			shape: { type: "ResponseShape", default: "rows" },
			unique: { type: "UniqueOn", default: "card" },
		},
	},

	_redirect_to_root: noParams(
		`Send the legacy index paths to /.

        Raises:
            falcon.HTTPMovedPermanently: Always; these paths exist only to redirect.
        `,
	),

	_root: {
		doc: `Return the index page, optionally with embedded search results.

        Args:
        ----
            falcon_response (falcon.Response): The Falcon response to write to.
            request_host (str): Value of the Host header, used to derive the site name.
            q (str): Search query (alternative to query parameter).
            query (str): Search query (alternative to q parameter).
            orderby (CardOrdering): Field to sort by.
            direction (SortDirection): Sort direction.
            unique (UniqueOn): Unique on field.
            prefer (PreferOrder): Prefer order.

        `,
		args: [],
		kwargs: {
			request_host: { type: "str", default: "" },
			q: { type: "str | None", default: null },
			query: { type: "str | None", default: null },
			orderby: { type: "CardOrdering | None", default: null },
			direction: { type: "SortDirection | None", default: null },
			unique: { type: "UniqueOn | None", default: null },
			prefer: { type: "PreferOrder | None", default: null },
		},
	},

	prefer_score_tuner: noParams(
		`Return the prefer score tuner page.

        Args:
        ----
            falcon_response (falcon.Response): The Falcon response to write to.

        `,
	),

	favicon_ico: noParams(SERVE_FILE_DOC("favicon.ico")),

	social_preview_webp: noParams("Return the social preview image."),

	styles_css: noParams(SERVE_FILE_DOC("styles.css")),

	app_js: noParams(SERVE_FILE_DOC("app.js")),

	app_min_js: noParams(SERVE_FILE_DOC("app.min.js")),

	robots_txt: noParams("Return the robots.txt file."),

	card_js: noParams(SERVE_FILE_DOC("card.js")),

	// ── The Scryfall-compatible /cards/* surface (upstream #912) ──────────────
	// Registered in upstream's own attribute order, which is where dir(cls) puts them: `cards`
	// with the five named sub-routes after it, all between `card` and
	// `discover_is_tags_from_syntax`.
	cards: {
		doc: `Serve every \`/cards/*\` route the five named sub-routes do not claim.

        The path shapes, by segment count:

        - \`/cards\` -- every card, paginated.
        - \`/cards/:id\` -- one card by Scryfall id.
        - \`/cards/:namespace/:id\` -- one card by multiverse, MTGO, Arena, TCGplayer or Cardmarket id.
        - \`/cards/:id/rulings\` -- the rulings for one card.
        - \`/cards/:code/:number\` -- one card by set code and collector number.
        - \`/cards/:code/:number/:lang\` -- the same, in one language.
        - \`/cards/:namespace/:id/rulings\` and \`/cards/:code/:number/rulings\` -- rulings, addressed
          the same two ways.
        `,
		args: [],
		kwargs: {
			identifier: { type: "str", default: "" },
			number: { type: "str", default: "" },
			suffix: { type: "str", default: "" },
			page: { type: "str", default: "1" },
			format: { type: "str", default: "json" },
			face: { type: "str", default: "front" },
			version: { type: "str", default: "large" },
			pretty: { type: "str", default: "false" },
		},
	},

	"cards/search": {
		doc: `Search for cards, paginated 175 at a time.

        \`include_extras\`, \`include_multilingual\` and \`include_variations\` are accepted and have no
        effect: the corpus holds no tokens, emblems or funny-set cards for \`include_extras\` to add,
        and it holds every printing and language it has imported unconditionally.
        `,
		args: [],
		kwargs: {
			q: { type: "str | None", default: null },
			unique: { type: "str", default: "cards" },
			order: { type: "str", default: "name" },
			dir: { type: "str", default: "auto" },
			page: { type: "str", default: "1" },
			format: { type: "str", default: "json" },
			pretty: { type: "str", default: "false" },
			include_extras: { type: "str", default: "false" },
			include_multilingual: { type: "str", default: "false" },
			include_variations: { type: "str", default: "false" },
		},
	},

	"cards/named": {
		doc: "Return one card by exact or fuzzy name.",
		args: [],
		kwargs: {
			exact: { type: "str | None", default: null },
			fuzzy: { type: "str | None", default: null },
			set: { type: "str | None", default: null },
			format: { type: "str", default: "json" },
			face: { type: "str", default: "front" },
			version: { type: "str", default: "large" },
			pretty: { type: "str", default: "false" },
		},
	},

	"cards/autocomplete": {
		doc: "Return up to 20 card names matching a partial name.",
		args: [],
		kwargs: {
			q: { type: "str | None", default: null },
			pretty: { type: "str", default: "false" },
			include_extras: { type: "str", default: "false" },
		},
	},

	"cards/random": {
		doc: "Return one random card, optionally restricted by a search query.",
		args: [],
		kwargs: {
			q: { type: "str | None", default: null },
			format: { type: "str", default: "json" },
			face: { type: "str", default: "front" },
			version: { type: "str", default: "large" },
			pretty: { type: "str", default: "false" },
		},
	},

	"cards/collection": {
		doc: "Resolve up to 75 card identifiers in one request.",
		args: [],
		kwargs: { pretty: { type: "str", default: "false" } },
	},

	// The reference half of the Scryfall surface (upstream #922): sets, catalogs and symbols,
	// mirrored off api.scryfall.com rather than derived from the corpus.
	catalog: {
		doc: `Return one catalog.

        The twenty names Scryfall documents; anything else is a 404 rather than an empty catalog.
        `,
		args: [],
		kwargs: {
			name: { type: "str", default: "" },
			pretty: { type: "str", default: "false" },
		},
	},

	"symbology/parse-mana": {
		doc: `Parse a mana cost into Scryfall's ManaCost object.

        The one route on this surface that reads no stored data: it is a pure function of \`cost\`,
        so it answers the same before the first import as after it.
        `,
		args: [],
		kwargs: {
			cost: { type: "str | None", default: null },
			pretty: { type: "str", default: "false" },
		},
	},

	sets: {
		doc: `Answer every \`/sets\` shape.

        Covers \`/sets\`, \`/sets/:code\`, \`/sets/:id\` and \`/sets/tcgplayer/:id\` — one handler
        because the router hands trailing segments to whichever route claims the first one.
        `,
		args: [],
		kwargs: {
			identifier: { type: "str", default: "" },
			second: { type: "str", default: "" },
			pretty: { type: "str", default: "false" },
		},
	},

	symbology: {
		doc: "Return every card symbol.",
		args: [],
		kwargs: { pretty: { type: "str", default: "false" } },
	},

	import_rulings: noParams(
		`Load the bulk rulings file into magic.rulings.

        Not implemented in this deployment: rulings come from Postgres upstream, and there is none
        here. See the README's deviations list.
        `,
	),

	card: {
		doc: `Serve the per-card page for /card/{set_code}/{collector_number}.

        Args:
        ----
            falcon_response (falcon.Response): The Falcon response to write to.
            set_code (str): The card set code extracted from the URL path.
            collector_number (str): The collector number extracted from the URL path.
            request_host (str): Host header value used to derive the site name shown in page chrome/title.
        `,
		args: [],
		kwargs: {
			set_code: { type: "str", default: "" },
			collector_number: { type: "str", default: "" },
			request_host: { type: "str", default: "" },
		},
	},

	get_migrations: noParams(
		`Get the migrations from the filesystem.

        Returns:
        -------
            List[Dict[str, str]]: List of migration metadata dictionaries.

        `,
	),

	get_catalog: noParams("Get type and keyword frequency catalogs from the engine."),

	get_common_keywords: noParams("Get the common keywords from the database."),

	backfill_prefer_scores: noParams(
		`Backfill prefer_score and prefer_score_components for all cards.

        This endpoint recalculates the prefer score for all existing cards based on:
        - Border color (black: 14, white: 0)
        - Frame version (2015: 42, 2003: 30)
        - Artwork popularity (logarithmic scaling: 23 * ln(count) / ln(40))
        - Rarity (common: 16, uncommon: 16, rare: 11, mythic: 0)
        - Extended art (12 points if present)
        - Highres scan (8 points if image_status='highres_scan')
        - Has paper (6 points if 'paper' in games array)
        - Language (English: 40 points)
        - Legendary frame (5 points if 'legendary' in frame_effects)
        - Non-showcase (10 points if 'showcase' not in frame_effects)
        - Finish (nonfoil: 10, foil: 5, etched: 0)
        - Artwork set (full-color: 20, black/white: 0)

        Returns:
            Dict with status and count of cards updated
        `,
	),

	backfill_cubecobra_scores: noParams(
		`Backfill cubecobra_score for all cards.

        Computes a weighted average of per-dimension PERCENT_RANK values (each in the 0-1
        range, where 0 is best and 1 is worst) and scales the result to a 0-100 score
        (0 = best, 100 = worst).

        The per-dimension weights are treated as relative and are internally normalized so
        that their sum is 100. Callers may supply any non-negative weights; they do not need
        to sum to 1.0.

        One score per distinct card_name is computed and then propagated to all printings.

        Returns:
            Dict with status and count of cards updated.
        `,
	),

	ingest_cubecobra: noParams(
		`Fetch card data from CubeCobra and store it in magic.cards.

        Paginates the CubeCobra top-cards API, then updates all matching rows
        in magic.cards (matched on oracle_id). Cards not present in CubeCobra
        are left with NULL values for the cubecobra_* columns.

        Returns:
            Dict with status and count of rows updated.
        `,
	),

	discover_is_tags_from_syntax: noParams(
		`Discover all available is: tags from Scryfall syntax documentation.

        Returns:
        -------
            List[str]: List of all available is: tag names.

        Raises:
        ------
            ValueError: If API request fails or returns invalid data.

        `,
	),

	import_oracle_tags: noParams(
		"Import oracle tags from Scryfall bulk data into oracle_tags, oracle_tag_relationships, and card_oracle_tags.",
	),

	import_art_tags: noParams(
		"Import art tags from Scryfall bulk data into art_tags, art_tag_relationships, and card_art_tags.",
	),

	import_all_is_tags: noParams(
		`Discover and import all is: tags from Scryfall syntax documentation.

        Returns:
        -------
            Dict[str, Any]: Summary of the bulk is: tag import operation.

        `,
	),

	import_card_by_name: {
		doc: `Import a single card by name from Scryfall API.

        Args:
        ----
            card_name (str): The exact name of the card to import.

        Returns:
        -------
            Dict[str, Any]: Result summary with import status and card info.

        `,
		args: [{ name: "card_name", type: "str" }],
		kwargs: {},
	},

	import_cards_by_search: {
		doc: `Import cards from Scryfall API using any search query.

        Args:
        ----
            search_query (str): The Scryfall search query to execute.

        Returns:
        -------
            Dict[str, Any]: Result summary with import status and card info.

        `,
		args: [{ name: "search_query", type: "str" }],
		kwargs: {},
	},

	random_search: {
		doc: `Return one or more random cards in the same envelope shape as search().

        Args:
            falcon_response: The Falcon response object.
            num_cards: The number of random cards to return (default is 1).
            shape: Shape of the "cards" list: 'rows' (list of card objects, default) or
                'columnar' (one list per field, keyed by field name — smaller on the wire).

        Returns:
            A dict with a "cards" key (list of card dicts) and "total_cards" key,
            matching the shape returned by search().
        `,
		args: [],
		kwargs: {
			num_cards: { type: "int", default: 1 },
			shape: { type: "ResponseShape", default: "rows" },
		},
	},
} satisfies Record<string, Listing>;
