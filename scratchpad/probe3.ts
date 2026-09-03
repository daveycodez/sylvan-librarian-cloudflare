const UA = { "User-Agent": "sylvan-librarian-parity/1.0", Accept: "application/json" };
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));
async function first(q: string) {
	const r = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=name`, { headers: UA });
	const j = await r.json() as any;
	await sleep(150);
	if (r.status !== 200) return console.log(q, "=>", r.status, j.details);
	const c = j.data[0];
	console.log(`${q}\n  -> ${c.name}  set=${c.set} rarity=${c.rarity} lang=${c.lang} games=${JSON.stringify(c.games)} finishes=${JSON.stringify(c.finishes)}`);
	const pr = await fetch(c.prints_search_uri, { headers: UA });
	const pj = await pr.json() as any;
	await sleep(150);
	console.log("     printings:", pj.data.map((p:any)=>`${p.set}/${p.collector_number}:${p.rarity}`).join(" "));
}
for (const q of process.argv.slice(2)) await first(q);
