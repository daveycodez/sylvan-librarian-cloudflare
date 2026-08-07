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

/** Convert mana cost symbols to HTML with CSS classes. */
export function convertManaSymbols(text: string, isModal = false): string {
	if (!text) {
		return "";
	}
	const symbolClass = isModal ? "modal-mana-symbol" : "mana-symbol";
	return text.replace(MANA_SYMBOL_RE, (symbol) => {
		const cssClasses = MANA_MAP[symbol];
		if (cssClasses) {
			return `<span class="${symbolClass} ${cssClasses}"></span>`;
		}
		return symbol; // Return unchanged if not in map
	});
}

/** Convert mana symbols to Unicode text (for alt text) — matches JS convertManaSymbolsToText. */
export function convertManaSymbolsToText(text: string): string {
	if (!text) {
		return "";
	}
	return text.replace(MANA_SYMBOL_RE, (symbol) => MANA_TEXT_MAP[symbol] ?? symbol);
}

/** Format oracle text with mana symbols and line breaks. */
export function formatOracleText(oracleText: string, isModal = false): string {
	if (!oracleText) {
		return "";
	}
	return convertManaSymbols(oracleText, isModal).replaceAll("\n", "<br>");
}

/** Build the CloudFront URL for a card image. */
export function buildImageUrl(card: CardRow, size: string): string {
	const face = card.face_idx ?? 1;
	return `https://d1hot9ps2xugbc.cloudfront.net/img/${card.set_code}/${card.collector_number}/${face}/${size}.webp`;
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

	// Build image URLs for srcset - using 4 sizes uniformly spread between 280 and 745
	const image280 = buildImageUrl(card, "280");
	const image388 = buildImageUrl(card, "388");
	const image538 = buildImageUrl(card, "538");
	const image745 = buildImageUrl(card, "745");

	const altText = buildAltText(card);

	// Build srcset and sizes for responsive images; sizes breakpoints are one
	// below the CSS grid min-width thresholds (see upstream comment).
	const srcset =
		`${escapeHtml(image280)} 280w, ` +
		`${escapeHtml(image388)} 388w, ` +
		`${escapeHtml(image538)} 538w, ` +
		`${escapeHtml(image745)} 745w`;
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
		`src="${escapeHtml(image388)}" ` +
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
