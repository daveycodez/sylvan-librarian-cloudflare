// Port of api/noscript_helpers.py: server-side rendering of search results for
// no-JS support. Byte-for-byte faithful, mana symbol handling and all.

const MAX_ORACLE_TEXT_LENGTH = 200;
const MAX_ALT_TEXT_LENGTH = 300; // oracle text truncation length in image alt/title text
const EAGER_LOAD_COUNT = 4; // covers a full first row at the widest common grid (4 columns)

/** A row from a search result; keys depend on the requested fields. */
export type CardRow = Record<string, unknown>;

/**
 * Escape HTML special characters. Matches the JS escapeHtml character set;
 * single quotes don't need escaping (all attributes use double quotes).
 */
export function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// Mana symbol mapping - matches JavaScript manaMap and hybridMap.
const MANA_MAP: Record<string, string> = {
	// Basic colors
	"{R}": "ms ms-r ms-cost",
	"{G}": "ms ms-g ms-cost",
	"{W}": "ms ms-w ms-cost",
	"{U}": "ms ms-u ms-cost",
	"{B}": "ms ms-b ms-cost",
	"{C}": "ms ms-c ms-cost",
	// Numbers
	"{0}": "ms ms-0 ms-cost",
	"{1}": "ms ms-1 ms-cost",
	"{2}": "ms ms-2 ms-cost",
	"{3}": "ms ms-3 ms-cost",
	"{4}": "ms ms-4 ms-cost",
	"{5}": "ms ms-5 ms-cost",
	"{6}": "ms ms-6 ms-cost",
	"{7}": "ms ms-7 ms-cost",
	"{8}": "ms ms-8 ms-cost",
	"{9}": "ms ms-9 ms-cost",
	"{10}": "ms ms-10 ms-cost",
	"{11}": "ms ms-11 ms-cost",
	"{12}": "ms ms-12 ms-cost",
	"{13}": "ms ms-13 ms-cost",
	"{14}": "ms ms-14 ms-cost",
	"{15}": "ms ms-15 ms-cost",
	"{16}": "ms ms-16 ms-cost",
	// Variables
	"{X}": "ms ms-x ms-cost",
	"{Y}": "ms ms-y ms-cost",
	"{Z}": "ms ms-z ms-cost",
	// Special
	"{T}": "ms ms-tap",
	"{Q}": "ms ms-untap",
	"{E}": "ms ms-energy",
	"{P}": "ms ms-p ms-cost",
	"{S}": "ms ms-s ms-cost",
	"{CHAOS}": "ms ms-chaos",
	"{PW}": "ms ms-pw",
	"{∞}": "ms ms-infinity",
	// Hybrid mana
	"{W/U}": "ms ms-wu ms-cost",
	"{U/B}": "ms ms-ub ms-cost",
	"{B/R}": "ms ms-br ms-cost",
	"{R/G}": "ms ms-rg ms-cost",
	"{G/W}": "ms ms-gw ms-cost",
	"{W/B}": "ms ms-wb ms-cost",
	"{U/R}": "ms ms-ur ms-cost",
	"{B/G}": "ms ms-bg ms-cost",
	"{R/W}": "ms ms-rw ms-cost",
	"{G/U}": "ms ms-gu ms-cost",
	// Hybrid with generic
	"{2/W}": "ms ms-2w ms-cost",
	"{2/U}": "ms ms-2u ms-cost",
	"{2/B}": "ms ms-2b ms-cost",
	"{2/R}": "ms ms-2r ms-cost",
	"{2/G}": "ms ms-2g ms-cost",
	// Phyrexian
	"{W/P}": "ms ms-wp ms-cost",
	"{U/P}": "ms ms-up ms-cost",
	"{B/P}": "ms ms-bp ms-cost",
	"{R/P}": "ms ms-rp ms-cost",
	"{G/P}": "ms ms-gp ms-cost",
	// Phyrexian hybrid
	"{W/U/P}": "ms ms-wup ms-cost",
	"{W/B/P}": "ms ms-wbp ms-cost",
	"{U/B/P}": "ms ms-ubp ms-cost",
	"{U/R/P}": "ms ms-urp ms-cost",
	"{B/R/P}": "ms ms-brp ms-cost",
	"{B/G/P}": "ms ms-bgp ms-cost",
	"{R/W/P}": "ms ms-rwp ms-cost",
	"{R/G/P}": "ms ms-rgp ms-cost",
	"{G/W/P}": "ms ms-gwp ms-cost",
	"{G/U/P}": "ms ms-gup ms-cost",
};

// Unicode text representations of mana symbols — matches JavaScript manaTextMap.
const MANA_TEXT_MAP: Record<string, string> = {
	"{W}": "☀️",
	"{U}": "💧",
	"{B}": "💀",
	"{R}": "🔥",
	"{G}": "🌳",
	"{C}": "◇",
	"{T}": "↻",
	"{Q}": "↺",
	"{E}": "⚡",
	"{P}": "Φ",
	"{S}": "❄",
	"{X}": "X",
	"{Y}": "Y",
	"{Z}": "Z",
	"{0}": "⓪",
	"{1}": "①",
	"{2}": "②",
	"{3}": "③",
	"{4}": "④",
	"{5}": "⑤",
	"{6}": "⑥",
	"{7}": "⑦",
	"{8}": "⑧",
	"{9}": "⑨",
	"{10}": "⑩",
	"{11}": "⑪",
	"{12}": "⑫",
	"{13}": "⑬",
	"{14}": "⑭",
	"{15}": "⑮",
	"{16}": "⑯",
	"{CHAOS}": "🌀",
	"{PW}": "PW",
	"{∞}": "♾︎",
	"{W/U}": "(☀️/💧)",
	"{U/B}": "(💧/💀)",
	"{B/R}": "(💀/🔥)",
	"{R/G}": "(🔥/🌳)",
	"{G/W}": "(🌳/☀️)",
	"{W/B}": "(☀️/💀)",
	"{U/R}": "(💧/🔥)",
	"{B/G}": "(💀/🌳)",
	"{R/W}": "(🔥/☀️)",
	"{G/U}": "(🌳/💧)",
	"{2/W}": "(②/☀️)",
	"{2/U}": "(②/💧)",
	"{2/B}": "(②/💀)",
	"{2/R}": "(②/🔥)",
	"{2/G}": "(②/🌳)",
	"{W/P}": "(☀️/Φ)",
	"{U/P}": "(💧/Φ)",
	"{B/P}": "(💀/Φ)",
	"{R/P}": "(🔥/Φ)",
	"{G/P}": "(🌳/Φ)",
	"{W/U/P}": "(☀️/💧/Φ)",
	"{W/B/P}": "(☀️/💀/Φ)",
	"{U/B/P}": "(💧/💀/Φ)",
	"{U/R/P}": "(💧/🔥/Φ)",
	"{B/R/P}": "(💀/🔥/Φ)",
	"{B/G/P}": "(💀/🌳/Φ)",
	"{R/W/P}": "(🔥/☀️/Φ)",
	"{R/G/P}": "(🔥/🌳/Φ)",
	"{G/W/P}": "(🌳/☀️/Φ)",
	"{G/U/P}": "(🌳/💧/Φ)",
};

const MANA_SYMBOL_RE = /\{[^}]{1,5}\}/g;

/**
 * Format raw card text: HTML-escape exactly once, then replace recognized mana tokens with
 * fixed span markup, optionally turning newlines into `<br>` (upstream #1039's
 * `format_card_text`, the single safe entry point both `convertManaSymbols` and
 * `formatOracleText` now go through).
 *
 * ESCAPE FIRST, SUBSTITUTE SECOND, and the order is the whole point. The callers used to hand
 * raw `mana_cost`/`oracle_text` straight to the symbol substitution, which emitted whatever the
 * card printed — so `Look at a card & say "done".` reached the page as raw `&` and `"`. Escaping
 * cannot damage the token vocabulary: `{`, `}`, `/` and the letters are all left alone by
 * `escapeHtml`, so `{W/U}` is still `{W/U}` after it and still matches.
 */
export function formatCardText(text: string, isModal = false, convertNewlines = false): string {
	if (!text) {
		return "";
	}
	const symbolClass = isModal ? "modal-mana-symbol" : "mana-symbol";
	const formatted = escapeHtml(text).replace(MANA_SYMBOL_RE, (symbol) => {
		const cssClasses = MANA_MAP[symbol];
		if (cssClasses) {
			return `<span class="${symbolClass} ${cssClasses}"></span>`;
		}
		return symbol; // Return unchanged if not in map
	});
	return convertNewlines ? formatted.replaceAll("\n", "<br>") : formatted;
}

/** Convert mana cost symbols to HTML with CSS classes. */
export function convertManaSymbols(text: string, isModal = false): string {
	return formatCardText(text, isModal, false);
}

/** Convert mana symbols to Unicode text (for alt text) — matches JS convertManaSymbolsToText. */
export function convertManaSymbolsToText(text: string): string {
	if (!text) {
		return "";
	}
	return text.replace(MANA_SYMBOL_RE, (symbol) => MANA_TEXT_MAP[symbol] ?? symbol);
}

/** Format oracle text with mana symbols and line breaks (accepts raw text). */
export function formatOracleText(oracleText: string, isModal = false): string {
	return formatCardText(oracleText, isModal, true);
}

/**
 * DELIBERATE DEVIATION from upstream: card images come from Scryfall's own CDN,
 * not upstream's CloudFront mirror.
 *
 * That mirror is populated by scripts/copy_images_to_s3.py against upstream's
 * Postgres and S3. This deployment has neither, so it was reading from a bucket
 * it cannot write to and does not control — and getting the wrong bytes: for
 * every transform/MDFC card the mirror's face-1 object is the BACK face's art
 * (measured: img/bot/6/1/*.webp is Slicer, High-Speed Antagonist), and no face-2
 * object exists at all. Fixed upstream separately; this port stops depending on
 * the mirror either way.
 *
 * Scryfall's path is a pure function of the card's id and the face side, so
 * nothing extra needs storing — which is also why upstream's own
 * `to_scryfall_card` re-emits `image_uris` rather than keeping them.
 *
 * `version` is one of Scryfall's names, not a pixel width: `normal` is 488px
 * wide, `large` 672, and `png` 745 (the only lossless one, and the only one with
 * a transparent rounded corner).
 */
const SCRYFALL_IMAGE_HOST = "https://cards.scryfall.io";

export function scryfallImageUrl(scryfallId: string, version: string, back = false): string {
	// Scryfall shards on the first two hex characters of the id.
	return `${SCRYFALL_IMAGE_HOST}/${version}/${back ? "back" : "front"}/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.${
		version === "png" ? "png" : "jpg"
	}`;
}

/** Build the image URL for a card row (front face; the no-JS render never flips). */
export function buildImageUrl(card: CardRow, version: string): string {
	const id = typeof card.scryfall_id === "string" ? card.scryfall_id : "";
	// No id means no derivable URL. Returning "" yields an empty src rather than a
	// URL that 404s on every size in the srcset.
	return id ? scryfallImageUrl(id, version) : "";
}

function str(value: unknown): string {
	return typeof value === "string" ? value : String(value);
}

/** Build descriptive image alt text with card name, mana cost, and oracle text. */
function buildAltText(card: CardRow): string {
	let altText = escapeHtml(str(card.name ?? "") || "Unknown Card");
	if (card.mana_cost) {
		const manaTextRepresentation = convertManaSymbolsToText(str(card.mana_cost));
		altText += ` / ${escapeHtml(manaTextRepresentation)}`;
	}
	altText += "\n\n";
	if (card.oracle_text) {
		let oracleTextWithSymbols = convertManaSymbolsToText(str(card.oracle_text));
		if (oracleTextWithSymbols.length > MAX_ALT_TEXT_LENGTH) {
			oracleTextWithSymbols = `${oracleTextWithSymbols.slice(0, MAX_ALT_TEXT_LENGTH)}...`;
		}
		altText += escapeHtml(oracleTextWithSymbols);
	}
	return altText;
}

/** Generate HTML for a single card (server-side rendering). */
export function createCardHtml(card: CardRow, index: number): string {
	const cardId = String(index);

	// Scryfall publishes three widths rather than upstream's four, so the srcset
	// carries the widths that actually exist instead of four names for the same
	// bytes. The default src stays the middle one, as it was at 388.
	const imageNormal = buildImageUrl(card, "normal"); // 488w jpg
	const imageLarge = buildImageUrl(card, "large"); // 672w jpg
	const imagePng = buildImageUrl(card, "png"); // 745w png, lossless

	const altText = buildAltText(card);

	// sizes breakpoints are one below the CSS grid min-width thresholds
	// (see upstream comment) and are unchanged: they describe the LAYOUT, not
	// the image sources, so they stay correct across a different set of widths.
	const srcset =
		`${escapeHtml(imageNormal)} 488w, ` + `${escapeHtml(imageLarge)} 672w, ` + `${escapeHtml(imagePng)} 745w`;
	const sizes =
		"(max-width: 409px) calc(100vw - 3.6em), " +
		"(max-width: 749px) calc(50vw - 2.6em - 7.5px), " +
		"(max-width: 1369px) calc(33.33vw - 2.27em - 10px), " +
		"(max-width: 2499px) calc(25vw - 2.1em - 11.25px), " +
		"calc(20vw - 2em - 12px)";

	// Create image HTML with srcset; 388px as default src.
	const priorityAttr = index === 0 ? ' fetchpriority="high"' : "";
	const lazyAttr = index < EAGER_LOAD_COUNT ? "" : ' loading="lazy"';
	const imgTag =
		`<img class="card-image" ` +
		`src="${escapeHtml(imageNormal)}" ` +
		`srcset="${srcset}" ` +
		`sizes="${sizes}" ` +
		`alt="${altText}" title="${altText}"${priorityAttr}${lazyAttr} />`;

	// Link the image to the card detail page — matches JS createCardHTML
	let imageHtml = imgTag;
	if (card.set_code && card.collector_number) {
		const cardPagePath = `/card/${escapeHtml(str(card.set_code))}/${escapeHtml(str(card.collector_number))}`;
		imageHtml = `<a href="${cardPagePath}" class="card-page-link">${imgTag}</a>`;
	}

	// Build card components
	const nameHtml = `<div class="card-name">${escapeHtml(str(card.name ?? "") || "Unknown Card")}</div>`;

	let manaHtml = "";
	if (card.mana_cost) {
		const manaConverted = convertManaSymbols(str(card.mana_cost), false);
		manaHtml = `<div class="card-mana">${manaConverted}</div>`;
	}

	let typeHtml = "";
	if (card.type_line) {
		typeHtml = `<div class="card-type">${escapeHtml(str(card.type_line))}</div>`;
	}

	let oracleHtml = "";
	if (card.oracle_text) {
		const oracleText = str(card.oracle_text);
		// Truncate carefully to avoid cutting mana symbols in half
		if (oracleText.length > MAX_ORACLE_TEXT_LENGTH) {
			let truncated = oracleText.slice(0, MAX_ORACLE_TEXT_LENGTH);
			// If we're in the middle of a mana symbol (unclosed brace), back up to before it
			const opens = truncated.split("{").length - 1;
			const closes = truncated.split("}").length - 1;
			if (opens > closes) {
				const lastBrace = truncated.lastIndexOf("{");
				truncated = lastBrace === -1 ? "" : truncated.slice(0, lastBrace);
			}
			const formatted = formatOracleText(truncated, false);
			oracleHtml = `<div class="card-text">${formatted}...</div>`;
		} else {
			const formatted = formatOracleText(oracleText, false);
			oracleHtml = `<div class="card-text">${formatted}</div>`;
		}
	}

	let setPowerHtml = "";
	const hasSet = Boolean(card.set_name);
	const hasPowerToughness =
		card.power !== null && card.power !== undefined && card.toughness !== null && card.toughness !== undefined;

	if (hasSet || hasPowerToughness) {
		const setPart = hasSet
			? `<div class="card-set">${escapeHtml(str(card.set_name))}</div>`
			: '<div class="card-set"></div>';
		let powerToughnessPart = "";
		if (hasPowerToughness) {
			powerToughnessPart = `<div class="card-power-toughness">${escapeHtml(str(card.power))} / ${escapeHtml(str(card.toughness))}</div>`;
		}
		setPowerHtml = `<div class="card-set-power-row">${setPart}${powerToughnessPart}</div>`;
	}

	return `
             <div class="card-item" data-card-id="${escapeHtml(cardId)}">
                 ${imageHtml}
                 <div class="card-name-mana-row">
                     ${nameHtml}
                     ${manaHtml}
                 </div>
                 ${typeHtml}
                 ${oracleHtml}
                 ${setPowerHtml}
             </div>
         `;
}

/** Generate HTML for all cards in search results. */
export function generateResultsHtml(cards: CardRow[]): string {
	return cards.map((card, i) => createCardHtml(card, i)).join("");
}

/** Generate HTML for the results count display. */
export function generateResultsCountHtml(totalCards: number, query: string): string {
	const escapedQuery = escapeHtml(query);
	const cardWord = totalCards === 1 ? "card" : "cards";
	return `Found ${totalCards} ${cardWord} matching "${escapedQuery}"`;
}
