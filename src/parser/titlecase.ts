/**
 * Port of the `titlecase` PyPI package, version 2.4.1 (the version upstream
 * installs), as used by card_query_nodes for card_name / card_artist values.
 *
 * Upstream does NOT install the optional `regex` package, so the `re`-fallback
 * pattern set is the production behavior; this port mirrors that branch only.
 * Python's `re` \w and \b are Unicode-aware ([\w] ~ letters+digits+underscore),
 * unlike JS \w/\b, so those are spelled out with property classes / lookarounds.
 * Case conversions go through the pystr helpers to match CPython.
 */

import { codePoints, fromCodePoints, pyCapitalize, pyLower, pyUpper } from "./pystr";

const SMALL = "a|an|and|as|at|but|by|en|for|if|in|of|on|or|the|to|v\\.?|via|vs\\.?";
// Python PUNCT char-class body, re-escaped for a JS character class.
const PUNCT = "!\"“#$%&'‘()*+,\\-–‒—―./:;?@\\[\\\\\\]_`{|}~";

// Python re's \w for str patterns: Unicode alphanumerics + underscore.
const W = "[\\p{L}\\p{N}_]";
// Python re's \b, spelled as lookarounds over the Unicode \w class.
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

const SMALL_WORDS = new RegExp(`^(${SMALL})$`, "iu");
const SMALL_FIRST = new RegExp(`^([${PUNCT}]*)(${SMALL})${B}`, "iu");
const SMALL_LAST = new RegExp(`${B}(${SMALL})[${PUNCT}]?$`, "iu");
// Note: case-sensitive in Python (compiled without re.I).
const SUBPHRASE = new RegExp(`([:.;?!\\-–‒—―][ ])(${SMALL})`, "gu");
// Python '.' matches everything except \n (not JS's wider line-terminator set).
const MAC_MC = new RegExp(`^([Mm]c|MC)(${W}[^\\n]+)`, "u");
const MR_MRS_MS_DR = /^((m((rs?)|s))|Dr)$/iu;
const INLINE_PERIOD = new RegExp(`${W}[.]${W}`, "iu");
const UC_ELSEWHERE = new RegExp(`^[${PUNCT}]*?[a-zA-Z]+[A-Z]+?`, "u");
const CAPFIRST = new RegExp(`^[${PUNCT}]*?(${W})`, "u");
const APOS_SECOND = new RegExp(`^[dol]['‘]${W}+(?:['s]{2})?$`, "iu");
const UC_INITIALS = /^(?:[A-Z]\.|[A-Z]\.[A-Z])+$/u;

const CONSONANTS_RE = /^[bcdfghjklmnpqrstvwxz]+$/iu;

/**
 * Port of titlecase.titlecase(text) with the upstream call shape:
 * no callback, preserve_blank_lines=False.
 */
export function titlecase(text: string, smallFirstLast = true): string {
	const lines = text.split(/[\r\n]+/);
	const processed: string[] = [];
	for (const line of lines) {
		const allCaps = pyUpper(line) === line;
		const words = line.split(/[\t ]/);
		const tcLine: string[] = [];
		for (let word of words) {
			if (allCaps && UC_INITIALS.test(word)) {
				tcLine.push(word);
				continue;
			}

			if (APOS_SECOND.test(word)) {
				const cps = codePoints(word);
				const c0 = fromCodePoints(cps.slice(0, 1));
				const c1 = fromCodePoints(cps.slice(1, 2));
				const c2 = fromCodePoints(cps.slice(2, 3));
				const rest = fromCodePoints(cps.slice(3));
				if (!"aeiouAEIOU".includes(c0)) {
					word = pyLower(c0) + c1 + pyUpper(c2) + rest;
				} else {
					word = pyUpper(c0) + c1 + pyUpper(c2) + rest;
				}
				tcLine.push(word);
				continue;
			}

			const macMatch = MAC_MC.exec(word);
			if (macMatch) {
				tcLine.push(`${pyCapitalize(macMatch[1] as string)}${titlecase(macMatch[2] as string, true)}`);
				continue;
			}

			if (MR_MRS_MS_DR.test(word)) {
				const cps = codePoints(word);
				word = pyUpper(fromCodePoints(cps.slice(0, 1))) + fromCodePoints(cps.slice(1));
				tcLine.push(word);
				continue;
			}

			if (INLINE_PERIOD.test(word) || (!allCaps && UC_ELSEWHERE.test(word))) {
				tcLine.push(word);
				continue;
			}
			if (SMALL_WORDS.test(word)) {
				tcLine.push(pyLower(word));
				continue;
			}

			if (word.includes("/") && !word.includes("//")) {
				tcLine.push(
					word
						.split("/")
						.map((t) => titlecase(t, false))
						.join("/"),
				);
				continue;
			}

			if (word.includes("-")) {
				tcLine.push(
					word
						.split("-")
						.map((t) => titlecase(t, false))
						.join("-"),
				);
				continue;
			}

			if (allCaps) {
				word = pyLower(word);
			}

			// A term with all consonants should be considered an acronym, unless too short.
			if (CONSONANTS_RE.test(word) && codePoints(word).length > 2) {
				tcLine.push(pyUpper(word));
				continue;
			}

			// Just a normal word that needs to be capitalized (CAPFIRST is ^-anchored,
			// so replace() touches at most one match, like Python's sub on it).
			tcLine.push(word.replace(CAPFIRST, (m) => pyUpper(m)));
		}

		if (smallFirstLast && tcLine.length > 0) {
			tcLine[0] = (tcLine[0] as string).replace(
				SMALL_FIRST,
				(_m, g1: string, g2: string) => `${g1}${pyCapitalize(g2)}`,
			);
			const last = tcLine.length - 1;
			tcLine[last] = (tcLine[last] as string).replace(SMALL_LAST, (m) => pyCapitalize(m));
		}

		let result = tcLine.join(" ");
		result = result.replace(SUBPHRASE, (_m, g1: string, g2: string) => `${g1}${pyCapitalize(g2)}`);
		processed.push(result);
	}
	return processed.join("\n");
}
