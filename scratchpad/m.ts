const UA = { "User-Agent": "sylvan-librarian-parity/1.0", Accept: "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const spec of process.argv.slice(2)) {
	const [q, extra = ""] = spec.split("||");
	const res = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q as string)}${extra}`, { headers: UA });
	const j = (await res.json()) as Record<string, unknown>;
	await sleep(120);
	const out = res.status !== 200
		? `${res.status} ${String(j.details ?? "")}${j.warnings ? ` W=${JSON.stringify(j.warnings)}` : ""}`
		: `${j.total_cards}${j.warnings ? ` W=${JSON.stringify(j.warnings)}` : ""}`;
	console.log(`${spec.padEnd(44)} ${out}`);
}
