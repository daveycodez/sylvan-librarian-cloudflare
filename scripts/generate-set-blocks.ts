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
// ─── A SET NAME WHERE THE CODE GOES ──────────────────────────────────────────────────────────
//
// Scryfall also resolves X as a set NAME: `block:zendikar` and `b:"return to ravnica"` answer their
// blocks. Measured on api.scryfall.com 2026-10-04, one request per row (unique=cards), each count
// read against the same block asked by code:
//
//   block:zendikar = block:ZENDIKAR = block:"zendikar" = block:worldwake
//       = block:"rise of the eldrazi"                           629 = block:zen
//   b:"return to ravnica" = block:returntoravnica               670 = block:rtr
//   block:"time spiral" = block:timespiral = block:"future sight" = block:"planar chaos"   752
//   block:"urza's saga" = block:"urzas saga"                    621   the apostrophe is optional
//   block:"kaldheim commander" = block:kaldheim-commander = block:kaldheim_commander
//       = block:"kaldheim  commander"                           7,558 = block:khc
//   block:"duel decks elves vs. goblins" = …"elves vs goblins"  56    and so is the period
//   block:"the lord of the rings tales of middle-earth"         289   and the hyphen
//   block:kaldheim 305   block:dominaria 265   block:"the dark" 119   block:"new phyrexia" 560
//   block:"kaldheim promos" 307 (= block:pkhm)   block:"kaldheim art series" 384 (= block:akhm)
//   block:"commander 2011" 7,302   block:"magic 2010" = block:"core set 2019" 3,579
//   block:"secret lair drop" 1,801   block:"vintage masters" 325   block:"historic anthology 1" 20
//   block:"30th anniversary edition" 286   block:"world championship decks 1997" 84
//
// So the value is the set's WHOLE name, compared with case, spaces, apostrophes, periods, hyphens
// and underscores removed from both sides — and then the set answers exactly as its code does.
// It is the whole name and nothing less:
//
//   block:"return to"  block:return  block:spiral  block:reborn  block:"city of guilds"
//   block:"midnight hunt"  block:"big score" (it is "The Big Score")  block:dark     404 each
//
// and the names of BLOCKS that are not also a set's name answer nothing (`block:urza`,
// `block:alara`, `block:"core set"`, `block:commander` are 404), so it is the set's name and not
// the `block` field.
//
// A COLON IN THE VALUE IS NEVER A NAME, even where the set's own name has one:
// `block:"kamigawa: neon dynasty"`, `block:"ravnica: city of guilds"`,
// `block:"innistrad: midnight hunt"` and `block:"innistrad: double feature"` are each 404, while
// `block:"kamigawa neon dynasty"` is 287, `block:"ravnica city of guilds"` 636 and
// `block:"innistrad double feature"` 728. The lookup below refuses a value carrying any character
// outside the six measured above, which is that rule and the safe reading of every character
// nobody measured.
//
// ─── EVERY SET'S NAME, ASKED ─────────────────────────────────────────────────────────────────
//
// The table once left the token sets out ("eight of twelve resolve and no rule separates them")
// and carried every other set's name on the strength of 38 that were asked. Both halves were
// wrong, so on 2026-10-08 ALL 1,056 sets of that day's `/sets` were asked, one request each:
// `e:"<name>"` with `include_extras=true&unique=prints`, the colon dropped, read against the
// set's own `e:<code>` count and against the sets the answer's cards are in.
//
//   set type          sets  answers   nothing   more than its set   no cards
//   token              216      191        23                   2
//   promo              300      284        14                   2
//   memorabilia         99       93         6
//   box                 44       39         4                   1
//   alchemy             19       17         1                                      1
//   treasure_chest       2        0         2
//   funny               22       21         1
//   masters             32       31         1
//   expansion          120      119                                                1
//   the 15 others      202      202
//   all              1,056      997        52                   5                  2
//
// (the 15: commander 45, duel_deck 27, core 25, draft_innovation 19, masterpiece 19, minigame 15,
// starter 15, from_the_vault 10, eternal 6, planechase 6, archenemy 4, arsenal 3, premium_deck 3,
// spellbook 3, vanguard 2.) The two sets with no cards cannot say under `e:` and do under `g:`:
// `g:"nauctis the sunken realm"` is `g:nau`'s 1 and `g:"alchemy reality fracture"` `g:yfra`'s 672.
//
// THE RULE IS NOT IN `/sets`, AND IT IS NOT THE SET TYPE. What Scryfall compares the value with is
// a name the set HAD — the one it was created with, kept when the set is renamed and copied when
// a set is split off another — and no field of the set object carries it:
//
//   e:"legendary cube"  149 = e:pz1, which is "Legendary Cube Prize Pack" today (a 404)
//   e:"you make the cube"  270 = e:pz2, "Treasure Chest" today (a 404)
//   e:"commander legends battle for baldurs gate promos"  104 = e:pclb, "Battle for Baldur's
//       Gate Promos" today (a 404) — while `e:"battle for baldurs gate tokens"` is tclb's 51
//   e:"mystery booster playtest cards"  242 = cmb1 AND cmb2; cmb2 answers its own name too (121)
//       and cmb1's, "Mystery Booster Playtest Cards 2019", is a 404
//   e:"historic anthology 4"  50 = ha4 and ha5, and `e:"historic anthology 5"` is a 404
//   e:"year of the ox 2021"  11 = pl21 and pl22 ("Year of the Tiger 2022", a 404)
//   e:"30th anniversary history promos"  12 = p30h and p30t ("…Celebration Tokyo", a 404)
//   e:"dominaria united tokens"  29 = tdmu and ptdmu ("…Southeast Asia Tokens", a 404)
//   e:"innistrad crimson vow tokens"  29 = tvow, tvoc and ovoc (the last two names 404s)
//
// Collisions, the digital flag, the release date, the card count, the parent and the block were
// each read against the 52 and none separates them: `tkhm` and `tkhc`, `tmid` and `tmic`, `tmh3`
// and `smh3` differ in nothing the catalog holds. So the table is every set's name, MINUS the 52
// measured to answer nothing (UNANSWERED_NAMES), with the names measured to answer several sets
// and the four former names (SHARED_NAMES, FORMER_NAMES). All three lists are that day's
// measurement and nothing else; a set renamed on Scryfall since is wrong here until it is asked
// again, in the direction of answering a name Scryfall does not.
//
// A NAME SEVERAL SETS ANSWER TO is all of them under `e:` and ONE of them wherever a single set
// is wanted — and which one follows no order of the catalog's (not the code, the name, the id,
// the date or the size), so it is measured per name:
//
//   g:"historic anthology 4" 25 = g:ha5 (not ha4)        block:"year of the ox 2021" 6 = block:pl21
//   in:"30th anniversary history promos" 60 = in:p30t (in:p30h is 254)
//   in:"innistrad crimson vow tokens" 8 = in:ovoc (in:tvoc 147, in:tvow 382), and
//       block:"innistrad crimson vow tokens" 1,365 = block:tvoc = block:ovoc (block:tvow 1,177)
//   in:"dominaria united tokens" 502 = in:tdmu; block:… 462 = block:tdmu (block:ptdmu 439)
//   g:"mystery booster playtest cards" 121 = g:cmb1
//
// A name that answers nothing answers nothing anywhere: `block:"kaldheim tokens"`,
// `g:"kaldheim tokens"`, `in:"kaldheim tokens"`, `g:"shadows of the past"`,
// `in:"mystery booster playtest cards 2019"` and `block:"historic anthology 5"` are 404s.
//
// ─── THE CHARACTERS OF A NAME ────────────────────────────────────────────────────────────────
//
// Seven names carry a character outside letters, digits, spaces and `: . ' -`. Each was asked as
// written and with the character dropped (2026-10-08):
//
//   e:"warhammer 40000 commander" = e:"warhammer 40 000 commander"  617    with the comma  404
//   e:"warhammer 40000 tokens"  31                                         with the comma  404
//   e:"url convention promos" = e:"urlconvention promos"  18               with the slash  404
//   e:"summer magic edgar"  306                                            with the slash  404
//   e:"global series jiang yanggu mu yanling"  41       with the `&` 404, and with "and" 404
//   e:"the list (unfinity foil edition)"  62                    WITHOUT the parentheses    404
//   e:"magic × duel masters promos"  4              WITHOUT the `×` 404, and with an `x`   404
//
// So the comma, the slash and the ampersand behave as the colon does — gone from the name, and a
// value that carries one is no name — while the parentheses and the multiplication sign are PART
// of the name and must be written. One reading fits every row here and above:
//
//   the name's key   lower-case, minus spaces and  ' . - : , / &
//   the value's key  lower-case, minus spaces and  ' . - _
//
// and the two must be equal. A name carrying any character not listed here is left out, and the
// generator says so: nobody measured it.
//
// ─── THE NICKNAMES ───────────────────────────────────────────────────────────────────────────
//
// Scryfall keeps a list of its own, and it is not derivable from `/sets`: `block:shards` is the
// Alara block and `block:alara` is not; `block:saga`, `block:legacy` and `block:destiny` are the
// Urza block and `block:urza` is not; `block:throne` and `block:eldraine` both answer and
// `block:eldritch`, `block:aether` and `block:oath` do not. No rule over the set objects separates
// the two halves (first word, last word, uniqueness and age were each tried against the rows
// below), so NICKNAMES is exactly the ones measured to answer, each with the count that names its
// set. A nickname nobody measured answers nothing here.
//
//   lea block 3,579: alpha beta unlimited revised fourth fifth sixth seventh eighth ninth tenth
//   usg block 621: saga legacy destiny          mmq block 621: mercadian masques
//   chk block 621: champions kamigawa betrayers saviors
//   ravnica 636   shards 540   scars 560   avacyn 659   khans 688   shadows 519   battle 494
//   rivals 483   throne = eldraine 285   ikoria 265   outlaws 371   duskmourn 276
//   "double feature" 728   "brothers war" 280 (the set is "The Brothers' War")
//   "lord of the rings tales of middle earth" 289
//
// Measured NOT to answer, so that nobody adds them on a guess: urza urzas alara reborn time spiral
// return eldrazi neon spark united brothers streets capenna age dawn planar chaos future sight
// rise besieged phyrexia ascension maze born nyx tarkir fate oath gatewatch eldritch aether hour
// guilds allegiance strixhaven classic arabian nights fallen empires starter midnight crimson
// machine wilds caverns murders edge modern horizons guild core commander restored.
//
// ─── `e:` / `set:` / `s:` / `edition:` READ THE SAME NAMES ───────────────────────────────────
//
// Measured on api.scryfall.com 2026-10-04, one request per row, each count the set's own:
//
//   e:zendikar = set:zendikar = s:zendikar = edition:zendikar = e:Zendikar = e=zendikar   234 = e:zen
//   e:"return to ravnica" = e:returntoravnica 254   e:"urza's saga" = e:urzassaga 335
//   e:kaldheim-commander = e:kaldheim_commander 119   e:"duel decks elves vs. goblins" 56
//   e:"kamigawa neon dynasty" 287, e:"kamigawa: neon dynasty" 404   e:"ravnica city of guilds" 291,
//   e:"ravnica: city of guilds" 404          the colon rule again
//   e:zendika  e:"tales of middle-earth"  e:"10th edition"  e:commander  e:mystery   404
//
// and every nickname above answers here with its set's count (all 36 asked: `e:saga` 335,
// `e:legacy` 143, `e:shards` 234, `e:alpha` 289, `e:"double feature"` 532 …) while `e:urza`,
// `e:alara`, `e:tarkir` and `e:eldritch` are 404. One table, two keywords.
//
// AND `g:` / `group:` AND `in:` READ IT TOO, each wanting one set (2026-10-08): `g:"lorwyn
// eclipsed tokens"` is `g:tecl`'s 764 and `block:"lorwyn eclipsed tokens"` `block:tecl`'s 421;
// `in:zendikar t:goblin` is `in:zen t:goblin`'s 27 prints, `in:"the list"` = `in:mb1` =
// `in:plst` 37,578, `in:dar` = `in:dom` 5,891, `in:ex t:goblin` = `in:exo t:goblin` 27,
// `in:alpha` = `in:lea` 10,289, `in:"kamigawa neon dynasty"` = `in:neo` 5,732 with the colon a
// 404, `in:"magic × duel masters promos"` = `in:pmda` 117, `-in:zendikar e:roe` = `-in:zen e:roe`
// 228. A set's name beats a set TYPE of the same word: `in:planechase` is `in:hop`'s 5,939 and
// `in:archenemy` `in:arc`'s 6,228, not the cards of every set of the type.
//
// A SET NAMED THIS WAY DOES NOT OPEN EXTRAS, where its code does — which is the one thing the
// rewrite to `e:<code>` would get wrong, and why the term policy tells the extras gate which
// codes it wrote: `e:plst` is 5,323 and `e:"the list"` 5,257 (= `e:plst -is:extra`);
// `e:mb2` 385 and `e:"mystery booster 2"` 264; `e:unk` 521 and `e:"unknown event"` a 404, as
// `e:"world championship decks 1997"` and `e:"lorwyn eclipsed tokens"` are — sets whose every card
// is an extra, which answer once `include:extras` is beside the name (tecl's 13). (`block:` opens
// extras whatever it is given, so the same names answer there.)
//
// ─── THE RETIRED CODES ───────────────────────────────────────────────────────────────────────
//
// `block:mb1` is 5,323 on Scryfall and no set has that code: Mystery Booster was folded into The
// List, and the old code still answers. Scryfall keeps such a list, and — like the nicknames — it
// is NOT the set objects' `mtgo_code` / `arena_code`: of the 24 sets whose MTGO code differs from
// their own, `e:dar` (dom, 265), `e:7e`, `e:ex`, `e:mi`, `e:pr`, `e:vi` and `e:wl` answer and
// `e:uz`, `e:te`, `e:in`, `e:ap`, `e:mm`, `e:ne`, `e:od`, `e:ps`, `e:st`, `e:ud`, `e:ul`, `e:ms2`,
// `e:ms3`, `e:ms4` and `e:pc1` are 404. So ALIASES is exactly the ones measured, each read
// against the count of the set it names (2026-10-04):
//
//   mb1 = fmb1 = plist   5,257 = e:plst -is:extra     (block:mb1 = block:fmb1 = block:plst 5,323)
//   dar 265 (block:dar 265)   2e 291   3e 295   4e 366   5e 432   6e 333   7e 335   8e 342   9e 344
//   ex 143   mi 335   pr 143   vi 167   wl 167   fe 102   ia 373   lg 306   aq 85   an 76   dk 119
//   nms 143 (nem)
//
// Measured NOT to answer: uz te in ap mm ne od ps st ud ul ms2 ms3 ms4 pc1 1e 2u ai hm ch po p2 pk
// ug cg gu le on sc ts tsts pc cs pch pmb1 dd3_evg. An alias does not open extras either
// (`e:mb1` is 5,257, and `e:mb1 include:extras` 5,323).
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
	name?: unknown;
	set_type?: unknown;
	block_code?: unknown;
	parent_set_code?: unknown;
}

/** The characters a set name may carry and still be in the table: the ones measured. */
const NAME_RE = /^[A-Za-z0-9 :.',/&()×-]+$/;

/**
 * A set name as the table keys it: lower-cased, its letters and digits — and its parentheses and
 * `×`, which a value must write. See THE CHARACTERS OF A NAME.
 */
const nameKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9()×]/g, "");

/**
 * MEASURED 2026-10-08 — the sets whose own name answers NOTHING on api.scryfall.com, by code:
 * 52 of the 1,056 asked. See EVERY SET'S NAME, ASKED. Not a rule: the list is the measurement,
 * and a code here that `/sets` no longer has stops the generator until it is asked again.
 */
const UNANSWERED_NAMES: readonly string[] = [
	// token (23)
	...["ptbro", "ptdmu", "smh3", "t30a", "tafc", "tbrc", "tbro", "tdd1", "tdmc", "tiko", "tkhm", "tmh2"],
	...["tmic", "tnec", "tneo", "tstx", "tunf", "tvoc", "wdmu", "wmkm", "wmom", "wone", "wwoe"],
	// promo (14)
	...["p30t", "pclb", "pcmr", "pf23", "pl22", "plg20", "plg21", "plg22", "prcq", "psvc", "ptsr", "pw21"],
	...["pw22", "pwor"],
	// memorabilia (6), box (4), treasure_chest (2), alchemy, funny, masters (1 each)
	...["adsk", "altr", "awoe", "oc21", "omic", "ovoc"],
	...["ha5", "psdg", "q06", "q07"],
	...["pz1", "pz2", "ysnc", "cmb1", "sis"],
];

/**
 * MEASURED 2026-10-08 — names a set answers to that are not its name today, as `[name key, set
 * code]`: the name it was created with. Found by asking; the catalog does not carry them, so
 * there are more that nobody has asked.
 */
const FORMER_NAMES: readonly (readonly [string, string])[] = [
	["legendarycube", "pz1"],
	["youmakethecube", "pz2"],
	["commanderlegendsbattleforbaldursgatepromos", "pclb"],
	["mysteryboosterplaytestcards", "cmb1"],
];

/**
 * MEASURED 2026-10-08 — the names MORE THAN ONE set answers to, as `[name key, sets]`. `e:` reads
 * all of them; the FIRST is the one set `block:`, `g:` and `in:` read, which no order of the
 * catalog's predicts. Each key is a set's name or a former name above.
 */
const SHARED_NAMES: readonly (readonly [string, readonly string[]])[] = [
	["dominariaunitedtokens", ["tdmu", "ptdmu"]],
	["innistradcrimsonvowtokens", ["ovoc", "tvoc", "tvow"]],
	["30thanniversaryhistorypromos", ["p30t", "p30h"]],
	["yearoftheox2021", ["pl21", "pl22"]],
	["historicanthology4", ["ha5", "ha4"]],
	["mysteryboosterplaytestcards", ["cmb1", "cmb2"]],
];

/**
 * Scryfall's own nicknames, as `[nickname key, set code]` — exactly the ones measured to answer.
 * See the header for the counts, and for the list measured NOT to answer.
 */
const NICKNAMES: readonly (readonly [string, string])[] = [
	["alpha", "lea"],
	["beta", "leb"],
	["unlimited", "2ed"],
	["revised", "3ed"],
	["fourth", "4ed"],
	["fifth", "5ed"],
	["sixth", "6ed"],
	["seventh", "7ed"],
	["eighth", "8ed"],
	["ninth", "9ed"],
	["tenth", "10e"],
	["saga", "usg"],
	["legacy", "ulg"],
	["destiny", "uds"],
	["mercadian", "mmq"],
	["masques", "mmq"],
	["champions", "chk"],
	["kamigawa", "chk"],
	["betrayers", "bok"],
	["saviors", "sok"],
	["ravnica", "rav"],
	["shards", "ala"],
	["scars", "som"],
	["avacyn", "avr"],
	["khans", "ktk"],
	["shadows", "soi"],
	["battle", "bfz"],
	["rivals", "rix"],
	["throne", "eld"],
	["eldraine", "eld"],
	["ikoria", "iko"],
	["outlaws", "otj"],
	["duskmourn", "dsk"],
	["doublefeature", "dbl"],
	["brotherswar", "bro"],
	["lordoftheringstalesofmiddleearth", "ltr"],
];

/**
 * Scryfall's retired and alternate set codes, as `[alias, set code]` — exactly the ones measured to
 * answer. See the header for the counts, and for the list measured NOT to answer.
 */
const ALIASES: readonly (readonly [string, string])[] = [
	["mb1", "plst"],
	["fmb1", "plst"],
	["plist", "plst"],
	["dar", "dom"],
	["2e", "2ed"],
	["3e", "3ed"],
	["4e", "4ed"],
	["5e", "5ed"],
	["6e", "6ed"],
	["7e", "7ed"],
	["8e", "8ed"],
	["9e", "9ed"],
	["ex", "exo"],
	["mi", "mir"],
	["pr", "pcy"],
	["vi", "vis"],
	["wl", "wth"],
	["fe", "fem"],
	["ia", "ice"],
	["lg", "leg"],
	["aq", "atq"],
	["an", "arn"],
	["dk", "drk"],
	["nms", "nem"],
];

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

	// `name key:code`, for every set but the ones measured to answer nothing — see the header. A
	// key that is also a set code would never be reached (the code is tried first), and two sets
	// under one key would make the answer depend on the order of `/sets`; neither exists today, and
	// either is refused here rather than resolved quietly.
	const codes = new Set<string>();
	for (const entry of sets as SetObject[]) codes.add(code(entry.code, "set code"));
	const names = new Map<string, string>();
	const addName = (key: string, own: string, what: string): void => {
		if (codes.has(key)) throw new Error(`${what} ${JSON.stringify(key)} is also a set code`);
		const taken = names.get(key);
		if (taken !== undefined && taken !== own)
			throw new Error(`${what} ${JSON.stringify(key)} names ${taken} and ${own}`);
		names.set(key, own);
	};
	const unanswered = new Set(UNANSWERED_NAMES);
	if (unanswered.size !== UNANSWERED_NAMES.length) throw new Error("UNANSWERED_NAMES lists a code twice");
	for (const own of unanswered) {
		if (!codes.has(own)) throw new Error(`${own} is measured to answer no name, and /sets does not have it`);
	}
	for (const entry of sets as SetObject[]) {
		const own = code(entry.code, "set code");
		if (own === "" || unanswered.has(own) || typeof entry.name !== "string") continue;
		if (!NAME_RE.test(entry.name)) {
			console.warn(`left out: ${own} ${JSON.stringify(entry.name)} carries a character nobody measured`);
			continue;
		}
		addName(nameKey(entry.name), own, "set name");
	}
	for (const [list, what] of [
		[NICKNAMES, "nickname"],
		[FORMER_NAMES, "former name"],
	] as const) {
		for (const [key, own] of list) {
			if (!codes.has(own)) throw new Error(`${what} ${key} names ${own}, which /sets does not have`);
			addName(key, own, what);
		}
	}
	// A shared name keeps its key and lists its sets, the one `block:` / `g:` / `in:` read first.
	const shared = new Map<string, readonly string[]>();
	for (const [key, owners] of SHARED_NAMES) {
		if (!names.has(key)) throw new Error(`shared name ${key} is no set's name and no former name`);
		if (owners.length < 2 || new Set(owners).size !== owners.length) throw new Error(`shared name ${key} is malformed`);
		for (const own of owners) {
			if (!codes.has(own)) throw new Error(`shared name ${key} names ${own}, which /sets does not have`);
		}
		const [first, ...rest] = owners as [string, ...string[]];
		shared.set(key, [first, ...rest.sort()]);
	}
	const nameRows = [...names].map(([key, own]) => `${key}:${(shared.get(key) ?? [own]).join(",")}`).sort();

	// `alias:code`. An alias that is a set's own code, or a name key, would never be reached or
	// would shadow one; neither exists today and either is refused.
	const aliasRows: string[] = [];
	for (const [alias, own] of ALIASES) {
		if (!codes.has(own)) throw new Error(`alias ${alias} names ${own}, which /sets does not have`);
		if (codes.has(alias)) throw new Error(`alias ${alias} is also a set code`);
		if (names.has(alias)) throw new Error(`alias ${alias} is also a set name`);
		aliasRows.push(`${alias}:${own}`);
	}
	aliasRows.sort();
	// As biome formats it: on the declaration's line while it fits the line width, under it after.
	const aliasLine = `const SET_ALIASES = "${aliasRows.join("|")}";`;
	const aliasLiteral = aliasLine.length <= 120 ? aliasLine : `const SET_ALIASES =\n\t"${aliasRows.join("|")}";`;

	const source = `// GENERATED FILE - do not edit. Built by scripts/generate-set-blocks.ts from api.scryfall.com/sets.
//
// The two set-object fields \`block:\` / \`b:\` are a function of — \`parent_set_code\` and
// \`block_code\` — for every set that has either, and the NAMES a set answers to where its code
// goes. See the generator for the measured rules.
//
// Committed and refreshed by hand with \`bun run set-blocks\`, never at deploy time.

// One string literal, parsed on first use: \`code:parent:block\` rows joined by \`|\`.
const SET_BLOCKS =
	"${rows.join("|")}";

// One string literal, parsed on first use: \`name:code\` rows joined by \`|\`. The name is the
// set's own, lower-cased and reduced to its letters, digits, parentheses and \`×\`, a name it
// had before, or one of Scryfall's nicknames. A set measured to answer no name is not here, and a
// name several sets answer to lists them all, \`name:code,code\` — see the generator.
const SET_NAMES =
	"${nameRows.join("|")}";

// \`alias:code\` rows joined by \`|\`: the retired and alternate codes Scryfall still answers to.
${aliasLiteral}

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

let namesParsed: ReadonlyMap<string, string> | null = null;

function setNames(): ReadonlyMap<string, string> {
	if (namesParsed === null) {
		const built = new Map<string, string>();
		for (const row of SET_NAMES.split("|")) {
			const sep = row.indexOf(":");
			built.set(row.slice(0, sep), row.slice(sep + 1));
		}
		namesParsed = built;
	}
	return namesParsed;
}

let aliasesParsed: ReadonlyMap<string, string> | null = null;

function setAliases(): ReadonlyMap<string, string> {
	if (aliasesParsed === null) {
		const built = new Map<string, string>();
		for (const row of SET_ALIASES.split("|")) {
			const sep = row.indexOf(":");
			if (sep < 0) continue;
			built.set(row.slice(0, sep), row.slice(sep + 1));
		}
		aliasesParsed = built;
	}
	return aliasesParsed;
}

/** What Scryfall drops from a set name written as a value: spaces, \`'\`, \`.\`, \`-\` and \`_\`. */
const NAME_SEPARATORS_RE = /[\\s'._-]/g;
/** What a name key is made of: a parenthesis or a \`×\` is part of the name, and is written. */
const NAME_KEY_RE = /^[a-z0-9()×]+$/;

/**
 * The shortest value \`setNameCode\` can resolve through SET_NAMES: no name key in the table is
 * shorter. A value under it that is no alias is a set code as written, so \`e:khm\` costs one
 * lookup in the alias map (${aliasRows.length} rows) and never parses the names.
 */
const SHORTEST_NAME_KEY = ${Math.min(...[...names.keys()].map((key) => key.length))};

/** The row a value names — one code, or several joined by \`,\` — or null. See \`setNameCode\`. */
function setNameRow(value: string): string | null {
	const lower = value.toLowerCase();
	const alias = setAliases().get(lower);
	if (alias !== undefined) return alias;
	if (lower.length < SHORTEST_NAME_KEY) return null;
	const key = lower.replace(NAME_SEPARATORS_RE, "");
	if (!NAME_KEY_RE.test(key)) return null;
	return setNames().get(key) ?? null;
}

/**
 * The set code a value names when it is NOT itself one: a retired or alternate code, the set's
 * whole name with case and the five separators ignored, a name it had before, or one of the
 * measured nicknames. null when it names nothing here — the value is then a set code as written,
 * known or not. A value carrying any other character (a colon above all) is no name:
 * \`e:"kamigawa: neon dynasty"\` answers nothing on api.scryfall.com where
 * \`e:"kamigawa neon dynasty"\` answers the set.
 *
 * ONE set, which is what \`block:\`, \`g:\` and \`in:\` read: of a name several sets answer to, the
 * one measured to be read there. \`e:\` reads them all — \`setNameCodes\`.
 *
 * No name key is also a set code (the generator refuses one), so this never has to ask whether
 * the value is a code first.
 */
export function setNameCode(value: string): string | null {
	const row = setNameRow(value);
	if (row === null) return null;
	const sep = row.indexOf(",");
	return sep < 0 ? row : row.slice(0, sep);
}

/**
 * Every set a value names, as \`e:\` reads it: one code but for the few names measured to answer
 * several sets (\`e:"dominaria united tokens"\` is tdmu and ptdmu). null as \`setNameCode\` is.
 */
export function setNameCodes(value: string): readonly string[] | null {
	const row = setNameRow(value);
	return row === null ? null : row.split(",");
}

/**
 * The set code a \`block:\` value names, or null when it names none this table knows.
 *
 * A set or block CODE in the table above is itself. Otherwise the value is read as \`e:\` reads
 * it — a retired code, a set NAME or a nickname; see \`setNameCode\`.
 */
export function blockValueCode(value: string): string | null {
	const lower = value.toLowerCase();
	const { sets, members } = setBlocks();
	if (sets.has(lower) || members.has(lower)) return lower;
	return setNameCode(lower);
}
`;

	writeFileSync(OUT, source);
	console.log(
		`Wrote ${OUT} — ${rows.length} sets with a block or a parent, ${nameRows.length} names, ${unanswered.size} sets left out`,
	);
}

await main();
