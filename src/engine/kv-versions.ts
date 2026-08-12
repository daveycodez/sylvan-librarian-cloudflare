// Retiring the keys a previous version left behind.
//
// A LAYOUT change mints a new key namespace — `reference:v1:*` becomes `reference:v2:*` — which is
// what lets a running reader keep reading keys it understands while the new ones land. The cost is
// that the old ones stay: 39 values, ~1.65MB, that nothing was pruning. The store solved the same
// problem years earlier with a retention sweep over its previous chunk keys, and this is that, for
// the datasets that arrived later.
//
// PRUNING RUNS AFTER THE META KEY, never before. The meta key is the commit point — it is what says
// a full set landed — so deleting the old namespace first would leave a window where neither
// version is complete. The store's publisher orders its own retention the same way.
//
// Best effort, always. A key that fails to delete costs a few KB of a 1GB namespace and gets
// another chance on the next publish; failing a completed publish over cleanup would be the worse
// trade.

/** Keys under `prefix` that are not part of `current`, i.e. left over from an older layout. */
export function staleKeys(all: string[], prefix: string, current: string): string[] {
	return all.filter((key) => key.startsWith(prefix) && !key.startsWith(current));
}
